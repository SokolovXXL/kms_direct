self.addEventListener('push', function(event) {
  if (!event.data) return;

  let data = {};
  try {
    data = event.data.json();
  } catch (e) {
    console.error('Invalid push data', e);
    return;
  }

  const options = {
    body: data.body,
    icon: data.icon || '/images/logo.png',
    badge: '/images/badge.png',
    data: data.data,
    requireInteraction: true,  // stays longer on mobile
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  const data = event.notification.data;
  if (data && data.conversationId) {
    // Open or focus the app
    const urlToOpen = new URL('/', self.location.origin);
    urlToOpen.searchParams.set('conversation', data.conversationId);

    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true })
        .then(windowClients => {
          for (let client of windowClients) {
            if (client.url === urlToOpen.href && 'focus' in client) {
              return client.focus();
            }
          }
          if (clients.openWindow) {
            return clients.openWindow(urlToOpen);
          }
        })
    );
  }
});