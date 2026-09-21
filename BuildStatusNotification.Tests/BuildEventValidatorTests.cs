using System.Text.Json;
using BuildStatusNotification.Models;
using BuildStatusNotification.Options;
using BuildStatusNotification.Services;
using Microsoft.Extensions.Options;
using Xunit;

namespace BuildStatusNotification.Tests;

public class BuildEventValidatorTests
{
    private readonly BuildEventValidator _validator;
    private readonly BuildEventPayload _startedSample;
    private readonly BuildEventPayload _finishedSample;

    public BuildEventValidatorTests()
    {
        var options = Microsoft.Extensions.Options.Options.Create(new NotifierOptions
        {
            TeamCityBaseUrl = "https://teamcity.example"
        });
        _validator = new BuildEventValidator(options);

        // Load samples from fixture file
        var fixtureJson = File.ReadAllText("../../../../docs/teamcity-payload.sample.json");
        var fixture = JsonSerializer.Deserialize<Dictionary<string, BuildEventPayload>>(fixtureJson,
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true });

        _startedSample = fixture!["started"];
        _finishedSample = fixture["finished"];
    }

    [Fact]
    public void StartedAndFinishedFromSameBuildGetDifferentIds()
    {
        var startedResult = _validator.TryCreate(_startedSample);
        var finishedResult = _validator.TryCreate(_finishedSample);

        Assert.True(startedResult.IsSuccess);
        Assert.True(finishedResult.IsSuccess);
        Assert.NotEqual(startedResult.Notification!.NotificationId, finishedResult.Notification!.NotificationId);
    }

    [Fact]
    public void SamePayloadTwiceGetsSameId()
    {
        var result1 = _validator.TryCreate(_startedSample);
        var result2 = _validator.TryCreate(_startedSample);

        Assert.True(result1.IsSuccess);
        Assert.True(result2.IsSuccess);
        Assert.Equal(result1.Notification!.NotificationId, result2.Notification!.NotificationId);
    }

    [Fact]
    public void MissingBuildIdFails()
    {
        var payload = _startedSample with { BuildId = "" };
        var result = _validator.TryCreate(payload);

        Assert.False(result.IsSuccess);
        Assert.Contains("BuildId", result.ErrorMessage);
    }

    [Fact]
    public void BuildUrlOnAnotherHostFails()
    {
        var payload = _startedSample with { BuildUrl = "https://evil.com/viewLog.html?buildId=320" };
        var result = _validator.TryCreate(payload);

        Assert.False(result.IsSuccess);
        Assert.Contains("BuildUrl", result.ErrorMessage);
    }

    [Fact]
    public void InvalidEventTypeFails()
    {
        var payload = _startedSample with { Event = "invalid" };
        var result = _validator.TryCreate(payload);

        Assert.False(result.IsSuccess);
        Assert.Contains("Event", result.ErrorMessage);
    }

    [Fact]
    public void InvalidStatusFails()
    {
        var payload = _startedSample with { Status = "INVALID" };
        var result = _validator.TryCreate(payload);

        Assert.False(result.IsSuccess);
        Assert.Contains("Status", result.ErrorMessage);
    }

    [Fact]
    public void FinishedEventRequiresFinishedAt()
    {
        var payload = _finishedSample with { FinishedAt = null };
        var result = _validator.TryCreate(payload);

        Assert.False(result.IsSuccess);
        Assert.Contains("FinishedAt", result.ErrorMessage);
    }

    [Fact]
    public void FinishedEventRequiresDurationSeconds()
    {
        var payload = _finishedSample with { DurationSeconds = null };
        var result = _validator.TryCreate(payload);

        Assert.False(result.IsSuccess);
        Assert.Contains("DurationSeconds", result.ErrorMessage);
    }

    [Fact]
    public void FinishedEventRequiresLogUrl()
    {
        var payload = _finishedSample with { LogUrl = null };
        var result = _validator.TryCreate(payload);

        Assert.False(result.IsSuccess);
        Assert.Contains("LogUrl", result.ErrorMessage);
    }

    [Fact]
    public void StartedEventWithRunningStatusSucceeds()
    {
        var result = _validator.TryCreate(_startedSample);

        Assert.True(result.IsSuccess);
        Assert.Equal("RUNNING", result.Notification!.Status);
    }

    [Fact]
    public void FinishedEventCannotHaveRunningStatus()
    {
        var payload = _finishedSample with { Status = "RUNNING" };
        var result = _validator.TryCreate(payload);

        Assert.False(result.IsSuccess);
        Assert.Contains("RUNNING", result.ErrorMessage);
    }
}
