using System.Security.Cryptography;

namespace BuildStatusNotification.Security;

public static class SecretVerifier
{
    public static bool MatchesSha256(string raw, string expectedHex)
    {
        if (string.IsNullOrWhiteSpace(raw) || string.IsNullOrWhiteSpace(expectedHex))
            return false;

        if (expectedHex.Length != 64)
            return false;

        byte[] expectedBytes;
        try
        {
            expectedBytes = Convert.FromHexString(expectedHex);
        }
        catch
        {
            return false;
        }

        var rawBytes = System.Text.Encoding.UTF8.GetBytes(raw);
        var actualBytes = SHA256.HashData(rawBytes);

        return CryptographicOperations.FixedTimeEquals(actualBytes, expectedBytes);
    }
}
