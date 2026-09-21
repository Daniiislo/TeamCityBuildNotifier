using System.Collections.Concurrent;
using BuildStatusNotification.Models;
using BuildStatusNotification.Options;
using Microsoft.Extensions.Options;

namespace BuildStatusNotification.Services;

public sealed class NotificationBuffer
{
    private readonly LinkedList<BuildNotification> _buffer = new();
    private readonly HashSet<string> _seenIds = new();
    private readonly object _lock = new();
    private readonly NotifierOptions _options;

    public NotificationBuffer(IOptions<NotifierOptions> options)
    {
        _options = options.Value;

        if (_options.BufferCapacity <= 0)
            throw new ArgumentException("BufferCapacity must be greater than 0", nameof(options));

        if (_options.BufferTtlMinutes <= 0)
            throw new ArgumentException("BufferTtlMinutes must be greater than 0", nameof(options));
    }

    public bool TryAdd(BuildNotification notification)
    {
        lock (_lock)
        {
            PurgeExpired();

            // Check for duplicate
            if (_seenIds.Contains(notification.NotificationId))
                return false;

            // Add to buffer
            _buffer.AddLast(notification);
            _seenIds.Add(notification.NotificationId);

            // Evict oldest if over capacity
            while (_buffer.Count > _options.BufferCapacity)
            {
                var oldest = _buffer.First!.Value;
                _buffer.RemoveFirst();
                _seenIds.Remove(oldest.NotificationId);
            }

            return true;
        }
    }

    public IReadOnlyList<BuildNotification> GetRecent(int limit)
    {
        lock (_lock)
        {
            PurgeExpired();

            return _buffer
                .TakeLast(Math.Min(limit, _buffer.Count))
                .ToList();
        }
    }

    public int Count
    {
        get
        {
            lock (_lock)
            {
                PurgeExpired();
                return _buffer.Count;
            }
        }
    }

    private void PurgeExpired()
    {
        var now = DateTimeOffset.UtcNow;
        var ttl = TimeSpan.FromMinutes(_options.BufferTtlMinutes);

        while (_buffer.Count > 0)
        {
            var oldest = _buffer.First!.Value;
            if (now - oldest.ReceivedAt <= ttl)
                break;

            _buffer.RemoveFirst();
            _seenIds.Remove(oldest.NotificationId);
        }
    }
}
