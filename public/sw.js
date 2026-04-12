self.addEventListener('push', function(event) {
  if (!event.data) {
    console.warn('Push event received without data');
    return;
  }

  let payload;
  try {
    payload = event.data.json();
  } catch (e) {
    try {
      const text = event.data.text();
      payload = { title: 'Новое сообщение', body: text };
    } catch {
      console.error('Failed to parse push data', e);
      return;
    }
  }

  const title = payload.title || 'Уведомление';
  const body = payload.body || '';
  const icon = payload.icon || '/images/logo.png';
  const badge = payload.badge || '/images/badge.png';
  const conversationId = payload.data?.conversationId || null;
  const requireInteraction = payload.requireInteraction !== false;

  const options = {
    body,
    icon,
    badge,
    data: {
      ...payload.data,
      conversationId,
      timestamp: Date.now()
    },
    requireInteraction,
    vibrate: payload.vibrate || [200, 100, 200],
    actions: payload.actions || []
  };

  event.waitUntil(
    self.registration.showNotification(title, options).catch(err => {
      console.error('Failed to show notification:', err);
    })
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  const data = event.notification.data || {};
  const conversationId = data.conversationId;

  const urlToOpen = new URL('/', self.location.origin);
  if (conversationId) {
    urlToOpen.searchParams.set('conversation', conversationId);
  }
  const targetUrl = urlToOpen.href;

  const openOrFocusWindow = async () => {
    const windowClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });

    for (const client of windowClients) {
      if (isSameConversationUrl(client.url, targetUrl) && 'focus' in client) {
        await client.focus();
        return;
      }
    }

    for (const client of windowClients) {
      const clientUrl = new URL(client.url);
      if (clientUrl.origin === self.location.origin && 'navigate' in client) {
        await client.navigate(targetUrl);
        await client.focus();
        return;
      }
    }

    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl);
    } else {
      console.warn('clients.openWindow not supported');
    }
  };

  event.waitUntil(
    openOrFocusWindow().catch(err => {
      console.error('Error handling notification click:', err);
    })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil(
    Promise.resolve()
  );
});

function isSameConversationUrl(clientUrl, targetUrl) {
  try {
    const client = new URL(clientUrl);
    const target = new URL(targetUrl);
    return (
      client.origin === target.origin &&
      client.pathname === target.pathname &&
      client.searchParams.get('conversation') === target.searchParams.get('conversation')
    );
  } catch {
    return false;
  }
}