namespace BuildStatusNotification.Options;

public sealed class NotifierOptions
{
    public const string SectionName = "Notifier";

    public string TeamTokenSha256 { get; set; } = string.Empty;
    public string WebhookSecretSha256 { get; set; } = string.Empty;
    public string TeamCityBaseUrl { get; set; } = string.Empty;
    public int BufferCapacity { get; set; } = 200;
    public int BufferTtlMinutes { get; set; } = 60;
    public int ReplayLimit { get; set; } = 50;
}
