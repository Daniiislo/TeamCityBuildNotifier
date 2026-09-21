using System.Security.Claims;
using System.Text.Encodings.Web;
using BuildStatusNotification.Options;
using BuildStatusNotification.Security;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;

namespace BuildStatusNotification.Auth;

public class TeamTokenAuthenticationHandler : AuthenticationHandler<AuthenticationSchemeOptions>
{
    private readonly NotifierOptions _options;

    public TeamTokenAuthenticationHandler(
        IOptionsMonitor<AuthenticationSchemeOptions> options,
        ILoggerFactory logger,
        UrlEncoder encoder,
        IOptions<NotifierOptions> notifierOptions)
        : base(options, logger, encoder)
    {
        _options = notifierOptions.Value;
    }

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        string? token = null;

        // Try Authorization header first
        if (Request.Headers.TryGetValue("Authorization", out var authHeader))
        {
            var headerValue = authHeader.ToString();
            if (headerValue.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
            {
                token = headerValue.Substring("Bearer ".Length).Trim();
            }
        }

        // For SignalR hub connections, also check query string
        if (token == null && Request.Path.StartsWithSegments("/hubs/builds"))
        {
            token = Request.Query["access_token"].FirstOrDefault();
        }

        if (string.IsNullOrWhiteSpace(token))
        {
            return Task.FromResult(AuthenticateResult.NoResult());
        }

        // Verify token
        if (!SecretVerifier.MatchesSha256(token, _options.TeamTokenSha256))
        {
            return Task.FromResult(AuthenticateResult.Fail("Invalid token"));
        }

        // Create claims principal
        var claims = new[] { new Claim(ClaimTypes.NameIdentifier, "team") };
        var identity = new ClaimsIdentity(claims, Scheme.Name);
        var principal = new ClaimsPrincipal(identity);
        var ticket = new AuthenticationTicket(principal, Scheme.Name);

        return Task.FromResult(AuthenticateResult.Success(ticket));
    }
}
