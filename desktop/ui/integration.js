'use strict';
window.StudioApp ||= {};
window.StudioApp.authenticationRequired = () => location.assign('/connect?auth=1');
window.StudioDesktopConnections.buildSettings = (body) => {
  const section = document.createElement('section');
  section.className = 'device-settings-section desktop-connection-settings';
  section.innerHTML = '<h3>服务器</h3><div class="desktop-connection-content"></div>';
  const content = section.lastElementChild;
  content.append(document.getElementById('desktopConnectionSettings').content.cloneNode(true));
  body.append(section);
  return window.StudioDesktopConnections.mount(content);
};

window.StudioServerSwitcher.mount(window.StudioDesktopConnections);

void window.StudioDesktopConnections.api('profiles').catch(() => {});
