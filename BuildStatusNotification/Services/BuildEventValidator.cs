using System.Security.Cryptography;
using System.Text;
using BuildStatusNotification.Models;
using BuildStatusNotification.Options;
using Microsoft.Extensions.Options;

namespace BuildStatusNotification.Services;

public sealed class BuildEventValidator
{
    private readonly NotifierOptions _options;
    private static readonly HashSet<string> ValidEvents = new() { "started", "finished" };
    private static readonly HashSet<string> ValidStatuses = new() { "RUNNING", "SUCCESS", "FAILURE", "CANCELLED" };

    public BuildEventValidator(IOptions<NotifierOptions> options)
    {
        _options = options.Value;
    }

    public ValidationResult TryCreate(BuildEventPayload payload)
    {
        // Validate event type
        if (string.IsNullOrWhiteSpace(payload.Event) || !ValidEvents.Contains(payload.Event))
            return ValidationResult.Fail("Event must be 'started' or 'finished'.");

        // Validate status
        if (string.IsNullOrWhiteSpace(payload.Status) || !ValidStatuses.Contains(payload.Status))
            return ValidationResult.Fail("Status must be one of: RUNNING, SUCCESS, FAILURE, CANCELLED.");

        // Validate required fields for all events
        if (string.IsNullOrWhiteSpace(payload.BuildId))
            return ValidationResult.Fail("BuildId is required.");

        if (string.IsNullOrWhiteSpace(payload.ProjectId))
            return ValidationResult.Fail("ProjectId is required.");

        if (string.IsNullOrWhiteSpace(payload.BuildUrl))
            return ValidationResult.Fail("BuildUrl is required.");

        // Validate event-specific requirements
        if (payload.Event == "started")
        {
            if (payload.Status != "RUNNING")
                return ValidationResult.Fail("Status must be RUNNING for started event.");
        }
        else if (payload.Event == "finished")
        {
            if (payload.Status == "RUNNING")
                return ValidationResult.Fail("Status cannot be RUNNING for finished event.");

            if (!payload.FinishedAt.HasValue)
                return ValidationResult.Fail("FinishedAt is required for finished event.");

            if (!payload.DurationSeconds.HasValue)
                return ValidationResult.Fail("DurationSeconds is required for finished event.");

            if (string.IsNullOrWhiteSpace(payload.LogUrl))
                return ValidationResult.Fail("LogUrl is required for finished event.");
        }

        // Validate URLs against TeamCityBaseUrl
        if (!IsAllowedUrl(payload.BuildUrl))
            return ValidationResult.Fail($"BuildUrl must start with {_options.TeamCityBaseUrl}.");

        if (!string.IsNullOrWhiteSpace(payload.LogUrl) && !IsAllowedUrl(payload.LogUrl))
            return ValidationResult.Fail($"LogUrl must start with {_options.TeamCityBaseUrl}.");

        // Derive NotificationId
        var notificationId = DeriveNotificationId(payload.ProjectId, payload.BuildId, payload.Event);

        // Build the notification
        var notification = new BuildNotification(
            NotificationId: notificationId,
            Event: payload.Event,
            ProjectId: payload.ProjectId,
            ProjectName: payload.ProjectName,
            BuildId: payload.BuildId,
            BuildTypeId: payload.BuildTypeId,
            BuildNumber: payload.BuildNumber,
            BuildName: payload.BuildName,
            BuildTitle: payload.BuildTitle,
            Branch: payload.Branch,
            Status: payload.Status,
            StatusText: payload.StatusText,
            TriggeredBy: payload.TriggeredBy,
            BuildUrl: payload.BuildUrl,
            LogUrl: payload.LogUrl,
            StartedAt: payload.StartedAt,
            FinishedAt: payload.FinishedAt,
            DurationSeconds: payload.DurationSeconds,
            Projects: payload.Projects,
            ReceivedAt: DateTimeOffset.UtcNow
        );

        return ValidationResult.Success(notification);
    }

    private bool IsAllowedUrl(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri))
            return false;

        if (!Uri.TryCreate(_options.TeamCityBaseUrl, UriKind.Absolute, out var baseUri))
            return false;

        return uri.Scheme == baseUri.Scheme &&
               uri.Host.Equals(baseUri.Host, StringComparison.OrdinalIgnoreCase) &&
               uri.Port == baseUri.Port;
    }

    private static string DeriveNotificationId(string projectId, string buildId, string eventType)
    {
        var input = $"{projectId}|{buildId}|{eventType}";
        var bytes = Encoding.UTF8.GetBytes(input);
        var hash = SHA256.HashData(bytes);
        return Convert.ToHexString(hash);
    }

    public sealed class ValidationResult
    {
        public bool IsSuccess { get; }
        public string? ErrorMessage { get; }
        public BuildNotification? Notification { get; }

        private ValidationResult(bool isSuccess, string? errorMessage, BuildNotification? notification)
        {
            IsSuccess = isSuccess;
            ErrorMessage = errorMessage;
            Notification = notification;
        }

        public static ValidationResult Success(BuildNotification notification) =>
            new(true, null, notification);

        public static ValidationResult Fail(string errorMessage) =>
            new(false, errorMessage, null);
    }
}
