using System.Text.Json;
using BuildStatusNotification.Hubs;
using BuildStatusNotification.Models;
using BuildStatusNotification.Options;
using BuildStatusNotification.Security;
using BuildStatusNotification.Services;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;

namespace BuildStatusNotification.Endpoints;

public static class TeamCityWebhookEndpoint
{
    public static RouteHandlerBuilder MapTeamCityWebhook(this WebApplication app)
    {
        return app.MapPost("/webhooks/teamcity", async (
            HttpContext context,
            IOptions<NotifierOptions> optionsAccessor,
            BuildEventValidator validator,
            NotificationBuffer buffer,
            IHubContext<BuildHub> hubContext,
            ILogger<Program> logger) =>
        {
            var options = optionsAccessor.Value;
            // 1. Require application/json
            if (!context.Request.HasJsonContentType())
            {
                logger.LogWarning("Rejected webhook: Invalid content type");
                return Results.BadRequest(new { error = "Content-Type must be application/json" });
            }

            // 2. Reject Content-Length > 65536
            if (context.Request.ContentLength.GetValueOrDefault(long.MaxValue) > 65536)
            {
                logger.LogWarning("Rejected webhook: Body too large ({Size} bytes)", context.Request.ContentLength);
                return Results.StatusCode(413);
            }

            // 3. Verify X-TeamCity-Secret BEFORE deserializing
            if (!context.Request.Headers.TryGetValue("X-TeamCity-Secret", out var secretHeader))
            {
                logger.LogWarning("Rejected webhook: Missing X-TeamCity-Secret header");
                return Results.Unauthorized();
            }

            var secret = secretHeader.ToString();
            if (!SecretVerifier.MatchesSha256(secret, options.WebhookSecretSha256))
            {
                logger.LogWarning("Rejected webhook: Invalid secret");
                return Results.Unauthorized();
            }

            // 4. Deserialize and validate
            BuildEventPayload? payload;
            try
            {
                payload = await context.Request.ReadFromJsonAsync<BuildEventPayload>();
                if (payload == null)
                {
                    logger.LogWarning("Rejected webhook: Empty payload");
                    return Results.BadRequest(new { error = "Payload is required" });
                }
            }
            catch (JsonException ex)
            {
                logger.LogWarning(ex, "Rejected webhook: Invalid JSON");
                return Results.BadRequest(new { error = "Invalid JSON" });
            }

            var validationResult = validator.TryCreate(payload);
            if (!validationResult.IsSuccess)
            {
                logger.LogWarning("Rejected webhook: Validation failed - {Error}", validationResult.ErrorMessage);
                return Results.BadRequest(new { error = validationResult.ErrorMessage });
            }

            var notification = validationResult.Notification!;

            // 5. TryAdd - if false (duplicate), return 200 with no broadcast
            if (!buffer.TryAdd(notification))
            {
                logger.LogInformation("Duplicate notification: {NotificationId} - {Event} - {BuildTitle}",
                    notification.NotificationId, notification.Event, notification.BuildTitle);
                return Results.Ok(new { status = "duplicate" });
            }

            // 6. Write audit event
            logger.LogInformation("Accepted notification: {NotificationId} - {Event} - {Status} - {BuildTitle} - {Branch}",
                notification.NotificationId,
                notification.Event,
                notification.Status,
                notification.BuildTitle,
                notification.Branch);

            // 7. Broadcast to all clients
            try
            {
                await hubContext.Clients.All.SendAsync("BuildEvent", notification, context.RequestAborted);
                logger.LogInformation("Broadcasted notification: {NotificationId}", notification.NotificationId);
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Failed to broadcast notification: {NotificationId}", notification.NotificationId);
                // Don't fail the request - the notification is in the buffer
            }

            // 8. Return 202
            return Results.Accepted(value: new { status = "accepted", notificationId = notification.NotificationId });
        })
        .WithName("TeamCityWebhook")
        .DisableAntiforgery();
    }
}
