namespace BuildStatusNotification.Models;

public sealed record BuildNotification(
    string NotificationId,
    string Event,
    string ProjectId,
    string ProjectName,
    string BuildId,
    string BuildTypeId,
    string BuildNumber,
    string BuildName,
    string BuildTitle,
    string Branch,
    string Status,
    string StatusText,
    string TriggeredBy,
    string BuildUrl,
    string? LogUrl,
    DateTimeOffset StartedAt,
    DateTimeOffset? FinishedAt,
    int? DurationSeconds,
    IReadOnlyList<string> Projects,
    DateTimeOffset ReceivedAt);
