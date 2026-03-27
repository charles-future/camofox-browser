function decodeProxyCredential(value) {
  if (!value) return value;

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function normalizePlaywrightProxy(proxy) {
  if (!proxy) return proxy;

  return {
    ...proxy,
    username: decodeProxyCredential(proxy.username),
    password: decodeProxyCredential(proxy.password),
  };
}
