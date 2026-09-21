using System.Threading.RateLimiting;
using BuildStatusNotification.Auth;
using BuildStatusNotification.Endpoints;
using BuildStatusNotification.Hubs;
using BuildStatusNotification.Options;
using BuildStatusNotification.Services;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.Extensions.Options;
using Serilog;
using Serilog.Formatting.Compact;

var builder = WebApplication.CreateBuilder(args);

// Configure Serilog
Log.Logger = new LoggerConfiguration()
    .ReadFrom.Configuration(builder.Configuration)
    // Console for humans, .jsonl for machines (grep/jq/Seq).
    .WriteTo.Console()
    .WriteTo.File(
        path: @"D:\AppData\BuildStatusNotification\Logs\notifier-.jsonl",
        formatter: new CompactJsonFormatter(),
        rollingInterval: RollingInterval.Day,
        retainedFileCountLimit: 14)
    .CreateLogger();

builder.Host.UseSerilog();

// Configure and validate options
builder.Services.AddOptions<NotifierOptions>()
    .BindConfiguration(NotifierOptions.SectionName)
    .ValidateDataAnnotations()
    .ValidateOnStart();

builder.Services.AddSingleton<IValidateOptions<NotifierOptions>, NotifierOptionsValidator>();

// Register services
builder.Services.AddSingleton<NotificationBuffer>();
builder.Services.AddSingleton<BuildEventValidator>();

// Configure authentication
builder.Services.AddAuthentication("TeamToken")
    .AddScheme<AuthenticationSchemeOptions, TeamTokenAuthenticationHandler>("TeamToken", null);

builder.Services.AddAuthorization();

// Configure SignalR
builder.Services.AddSignalR(options =>
{
    options.KeepAliveInterval = TimeSpan.FromSeconds(15);
    options.ClientTimeoutInterval = TimeSpan.FromSeconds(45);
    options.MaximumReceiveMessageSize = 32 * 1024; // 32 KB
});

// Configure rate limiting
builder.Services.AddRateLimiter(options =>
{
    options.AddFixedWindowLimiter("webhook", limiterOptions =>
    {
        limiterOptions.Window = TimeSpan.FromMinutes(1);
        limiterOptions.PermitLimit = 60;
        limiterOptions.QueueLimit = 0;
    });
});

var app = builder.Build();

// Enable forwarded headers if behind a proxy
app.UseForwardedHeaders(new ForwardedHeadersOptions
{
    ForwardedHeaders = Microsoft.AspNetCore.HttpOverrides.ForwardedHeaders.XForwardedFor |
                       Microsoft.AspNetCore.HttpOverrides.ForwardedHeaders.XForwardedProto
});

// Local extension testing uses http://localhost:5104. Redirecting that request
// to HTTPS can drop the Authorization header during SignalR negotiation.
if (!app.Environment.IsDevelopment())
{
    app.UseHttpsRedirection();
}

app.UseAuthentication();
app.UseAuthorization();

app.UseRateLimiter();

// Map endpoints
app.MapGet("/health", () => new { status = "Healthy" });

app.MapHub<BuildHub>("/hubs/builds");

// Webhook endpoint uses X-TeamCity-Secret header, not TeamToken auth scheme
app.MapTeamCityWebhook()
   .RequireRateLimiting("webhook");

try
{
    Log.Information("Starting BuildStatusNotification API");
    app.Run();
}
catch (Exception ex)
{
    Log.Fatal(ex, "Application terminated unexpectedly");
}
finally
{
    Log.CloseAndFlush();
}
