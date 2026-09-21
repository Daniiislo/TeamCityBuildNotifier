// URL validation - must compare origins, not string prefixes
export function isAllowedBuildUrl(url, baseUrl) {
  try {
    const urlObj = new URL(url);
    const baseObj = new URL(baseUrl);

    return urlObj.protocol === baseObj.protocol &&
           urlObj.hostname.toLowerCase() === baseObj.hostname.toLowerCase() &&
           urlObj.port === baseObj.port;
  } catch {
    return false;
  }
}
