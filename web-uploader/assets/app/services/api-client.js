async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    error.responseText = text;
    throw error;
  }
}

export function createApiClient({ fetchImpl = window.fetch.bind(window) } = {}) {
  return {
    fetch: fetchImpl,
    async getJson(url, init = {}) {
      const response = await fetchImpl(url, init);
      const json = await readJson(response);
      if (!response.ok) {
        const error = new Error(json?.error || `HTTP ${response.status}`);
        error.status = response.status;
        error.payload = json;
        throw error;
      }
      return json;
    },
    async postJson(url, body, init = {}) {
      return this.getJson(url, {
        ...init,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(init.headers || {}),
        },
        body: JSON.stringify(body),
      });
    },
    async getText(url, init = {}) {
      const response = await fetchImpl(url, init);
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(text || `HTTP ${response.status}`);
        error.status = response.status;
        error.responseText = text;
        throw error;
      }
      return text;
    },
    async postForm(url, body, init = {}) {
      const response = await fetchImpl(url, {
        ...init,
        method: 'POST',
        body,
      });
      const json = await readJson(response);
      if (!response.ok) {
        const error = new Error(json?.error || `HTTP ${response.status}`);
        error.status = response.status;
        error.payload = json;
        throw error;
      }
      return json;
    },
  };
}
