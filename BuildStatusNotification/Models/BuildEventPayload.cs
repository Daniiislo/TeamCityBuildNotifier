namespace BuildStatusNotification.Models;

public sealed record BuildEventPayload
{
    public string Event { get; init; } = string.Empty;
    public string BuildId { get; init; } = string.Empty;
    public string BuildTypeId { get; init; } = string.Empty;
    public string ProjectId { get; init; } = string.Empty;
    public string ProjectName { get; init; } = string.Empty;
    public string BuildName { get; init; } = string.Empty;
    public string BuildTitle { get; init; } = string.Empty;
    public string BuildNumber { get; init; } = string.Empty;
    public string Branch { get; init; } = string.Empty;
    public string Status { get; init; } = string.Empty;
    public string StatusText { get; init; } = string.Empty;
    public string TriggeredBy { get; init; } = string.Empty;
    public string BuildUrl { get; init; } = string.Empty;
    public string? LogUrl { get; init; }
    public DateTimeOffset StartedAt { get; init; }
    public DateTimeOffset? FinishedAt { get; init; }
    public int? DurationSeconds { get; init; }
    public IReadOnlyList<string> Projects { get; init; } = Array.Empty<string>();
}
