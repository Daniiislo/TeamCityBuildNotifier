# Build Error Fix

**Error:** Operator '.' cannot be applied to operand of type 'void'

**Location:** `BuildStatusNotification/Program.cs` line calling `MapTeamCityWebhook()`

**Root Cause:** 
`MapTeamCityWebhook()` was declared as `void` but Program.cs tried to chain `.RequireRateLimiting()` on its return value.

**Fix Applied:**
Changed method signature from:
```csharp
public static void MapTeamCityWebhook(this WebApplication app)
```

To:
```csharp
public static RouteHandlerBuilder MapTeamCityWebhook(this WebApplication app)
{
    return app.MapPost(...) // Return the RouteHandlerBuilder
}
```

**Status:** ✅ Fixed

**To Verify:**
```powershell
cd BuildStatusNotification
dotnet build
```

Should build successfully now.
