using BuildStatusNotification.Models;
using BuildStatusNotification.Options;
using BuildStatusNotification.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;

namespace BuildStatusNotification.Hubs;

[Authorize]
public class BuildHub : Hub
{
    private readonly NotificationBuffer _buffer;
    private readonly NotifierOptions _options;
    private readonly ILogger<BuildHub> _logger;

    public BuildHub(
        NotificationBuffer buffer,
        IOptions<NotifierOptions> options,
        ILogger<BuildHub> logger)
    {
        _buffer = buffer;
        _options = options.Value;
        _logger = logger;
    }

    public IReadOnlyList<BuildNotification> GetRecent(int limit)
    {
        var clampedLimit = Math.Clamp(limit, 1, _options.ReplayLimit);
        var notifications = _buffer.GetRecent(clampedLimit);

        _logger.LogInformation("Client requested {RequestedLimit} recent notifications, returning {ActualCount}",
            limit, notifications.Count);

        return notifications;
    }

    public override Task OnConnectedAsync()
    {
        _logger.LogInformation("Client connected: {ConnectionId}", Context.ConnectionId);
        return base.OnConnectedAsync();
    }

    public override Task OnDisconnectedAsync(Exception? exception)
    {
        if (exception != null)
        {
            _logger.LogWarning(exception, "Client disconnected with error: {ConnectionId}", Context.ConnectionId);
        }
        else
        {
            _logger.LogInformation("Client disconnected: {ConnectionId}", Context.ConnectionId);
        }
        return base.OnDisconnectedAsync(exception);
    }
}
