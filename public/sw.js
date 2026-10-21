self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('push',event=>{if(!event.data)return;const p=event.data.json();event.waitUntil(self.registration.showNotification(p.title,{body:p.body,icon:'/icon.svg',tag:p.id,renotify:false,data:{url:p.url}}));});
self.addEventListener('notificationclick',event=>{event.notification.close();const path=event.notification.data?.url;const target=new URL(typeof path==='string'&&path.startsWith('/')?path:'/app',self.location.origin);if(target.origin!==self.location.origin)return;event.waitUntil(self.clients.openWindow(target.href));});
