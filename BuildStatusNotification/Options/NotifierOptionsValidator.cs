using BuildStatusNotification.Options;
using Microsoft.Extensions.Options;

namespace BuildStatusNotification.Options;

public sealed class NotifierOptionsValidator : IValidateOptions<NotifierOptions>
{
    private readonly IHostEnvironment _environment;

    public NotifierOptionsValidator(IHostEnvironment environment)
    {
        _environment = environment;
    }

    public ValidateOptionsResult Validate(string? name, NotifierOptions options)
    {
        var errors = new List<string>();

        // Validate TeamTokenSha256
        if (string.IsNullOrWhiteSpace(options.TeamTokenSha256))
            errors.Add("TeamTokenSha256 is required.");
        else if (options.TeamTokenSha256.Length != 64)
            errors.Add("TeamTokenSha256 must be exactly 64 characters (SHA-256 hex).");

        // Validate WebhookSecretSha256
        if (string.IsNullOrWhiteSpace(options.WebhookSecretSha256))
            errors.Add("WebhookSecretSha256 is required.");
        else if (options.WebhookSecretSha256.Length != 64)
            errors.Add("WebhookSecretSha256 must be exactly 64 characters (SHA-256 hex).");

        // Validate TeamCityBaseUrl
        if (string.IsNullOrWhiteSpace(options.TeamCityBaseUrl))
        {
            errors.Add("TeamCityBaseUrl is required.");
        }
        else if (!Uri.TryCreate(options.TeamCityBaseUrl, UriKind.Absolute, out var uri))
        {
            errors.Add("TeamCityBaseUrl must be a valid absolute URL.");
        }
        else if (!_environment.IsDevelopment() && uri.Scheme != "https")
        {
            errors.Add("TeamCityBaseUrl must use HTTPS in non-Development environments.");
        }

        // Validate capacity and limits
        if (options.BufferCapacity <= 0)
            errors.Add("BufferCapacity must be greater than 0.");

        if (options.BufferTtlMinutes <= 0)
            errors.Add("BufferTtlMinutes must be greater than 0.");

        if (options.ReplayLimit <= 0)
            errors.Add("ReplayLimit must be greater than 0.");

        return errors.Count > 0
            ? ValidateOptionsResult.Fail(errors)
            : ValidateOptionsResult.Success;
    }
}
