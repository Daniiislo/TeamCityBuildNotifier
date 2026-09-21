using BuildStatusNotification.Models;
using BuildStatusNotification.Options;
using BuildStatusNotification.Services;
using Microsoft.Extensions.Options;
using Xunit;

namespace BuildStatusNotification.Tests;

public class NotificationBufferTests
{
    private readonly NotificationBuffer _buffer;

    public NotificationBufferTests()
    {
        var options = Microsoft.Extensions.Options.Options.Create(new NotifierOptions
        {
            BufferCapacity = 5,
            BufferTtlMinutes = 60
        });
        _buffer = new NotificationBuffer(options);
    }

    private BuildNotification CreateNotification(string id, DateTimeOffset? receivedAt = null)
    {
        return new BuildNotification(
            NotificationId: id,
            Event: "finished",
            ProjectId: "test",
            ProjectName: "Test",
            BuildId: "123",
            BuildTypeId: "Test_Build",
            BuildNumber: "1",
            BuildName: "Build",
            BuildTitle: "Test Build",
            Branch: "main",
            Status: "SUCCESS",
            StatusText: "Success",
            TriggeredBy: "user",
            BuildUrl: "https://teamcity.example/build",
            LogUrl: "https://teamcity.example/log",
            StartedAt: DateTimeOffset.UtcNow,
            FinishedAt: DateTimeOffset.UtcNow,
            DurationSeconds: 100,
            Projects: new[] { "Project1" },
            ReceivedAt: receivedAt ?? DateTimeOffset.UtcNow
        );
    }

    [Fact]
    public void DuplicateIdReturnsFalse()
    {
        var notification = CreateNotification("id1");

        var firstAdd = _buffer.TryAdd(notification);
        var secondAdd = _buffer.TryAdd(notification);

        Assert.True(firstAdd);
        Assert.False(secondAdd);
        Assert.Equal(1, _buffer.Count);
    }

    [Fact]
    public void OldestEntryIsEvictedAtCapacity()
    {
        // Add 6 items to a buffer with capacity 5
        for (int i = 1; i <= 6; i++)
        {
            _buffer.TryAdd(CreateNotification($"id{i}"));
        }

        Assert.Equal(5, _buffer.Count);

        // Get recent should return the last 5
        var recent = _buffer.GetRecent(10);
        Assert.Equal(5, recent.Count);
        Assert.Equal("id2", recent[0].NotificationId);
        Assert.Equal("id6", recent[4].NotificationId);
    }

    [Fact]
    public void ExpiredEntriesDisappear()
    {
        var expiredTime = DateTimeOffset.UtcNow.AddMinutes(-61);
        var recentTime = DateTimeOffset.UtcNow;

        _buffer.TryAdd(CreateNotification("expired1", expiredTime));
        _buffer.TryAdd(CreateNotification("expired2", expiredTime));
        _buffer.TryAdd(CreateNotification("recent1", recentTime));

        var count = _buffer.Count;
        var recent = _buffer.GetRecent(10);

        Assert.Equal(1, count);
        Assert.Single(recent);
        Assert.Equal("recent1", recent[0].NotificationId);
    }

    [Fact]
    public void GetRecentReturnsChronologicalOrder()
    {
        _buffer.TryAdd(CreateNotification("id1"));
        _buffer.TryAdd(CreateNotification("id2"));
        _buffer.TryAdd(CreateNotification("id3"));

        var recent = _buffer.GetRecent(10);

        Assert.Equal(3, recent.Count);
        Assert.Equal("id1", recent[0].NotificationId);
        Assert.Equal("id2", recent[1].NotificationId);
        Assert.Equal("id3", recent[2].NotificationId);
    }

    [Fact]
    public void GetRecentRespectsLimit()
    {
        _buffer.TryAdd(CreateNotification("id1"));
        _buffer.TryAdd(CreateNotification("id2"));
        _buffer.TryAdd(CreateNotification("id3"));

        var recent = _buffer.GetRecent(2);

        Assert.Equal(2, recent.Count);
        Assert.Equal("id2", recent[0].NotificationId);
        Assert.Equal("id3", recent[1].NotificationId);
    }
}
