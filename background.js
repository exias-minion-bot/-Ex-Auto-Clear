// background.js

// ─── 0) All types + origin-filterable subset ────────────────────────────────
const ALL_TYPES = [
  'appcache','cache','cacheStorage','cookies','downloads','fileSystems',
  'formData','history','indexedDB','localStorage','pluginData','passwords',
  'serviceWorkers','webSQL','serverBoundCertificates'
];

// Only these types honor {origins: [...]}
const ORIGIN_FILTERABLE = [
  'cacheStorage','cookies','fileSystems',
  'indexedDB','localStorage','pluginData',
  'serviceWorkers','webSQL'
];

// ─── 1) Defaults & Settings APIs ─────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  enabled: false, interval: 60, quietStart: '', quietEnd: '',
  notifications: false, types: ALL_TYPES.slice(),
  filters: [], lastRun: null
};

function getSettings() {
  return new Promise(res =>
    chrome.storage.local.get(['settings'], r =>
      res(Object.assign({}, DEFAULT_SETTINGS, r.settings))
    )
  );
}

function saveSettings(settings) {
  return new Promise(res =>
    chrome.storage.local.set({ settings }, () => {
      scheduleAlarm(settings);
      res();
    })
  );
}

function scheduleAlarm({ enabled, interval }) {
  chrome.alarms.clear('autoClear', () => {
    if (enabled) chrome.alarms.create('autoClear', { periodInMinutes: interval });
  });
}

function inQuietHours({ quietStart, quietEnd }) {
  if (!quietStart||!quietEnd) return false;
  const now = new Date();
  const [sh,sm] = quietStart.split(':').map(Number);
  const [eh,em] = quietEnd.split(':').map(Number);
  const start = new Date(now); start.setHours(sh,sm,0,0);
  const end   = new Date(now); end.setHours(eh,em,0,0);
  return start<end ? now>=start&&now<=end : now>=start||now<=end;
}

function finalizeClear(settings, details) {
  settings.lastRun = new Date().toISOString();
  return new Promise(res =>
    chrome.storage.local.set({ settings }, () =>
      res({ details, settings })
    )
  );
}

function cookieToOrigin(cookie) {
  const d = cookie.domain.replace(/^\./,'');
  return (cookie.secure?'https://':'http://') + d;
}

// ─── 2) Clear one origin’s filterable data ──────────────────────────────────
function clearFilteredOrigin(origin, typesMask) {
  const mask = {};
  Object.keys(typesMask).forEach(t => {
    if (typesMask[t] && ORIGIN_FILTERABLE.includes(t)) mask[t] = true;
  });
  if (!Object.keys(mask).length) return Promise.resolve();
  return new Promise(r =>
    chrome.browsingData.remove({since:0,origins:[origin]}, mask, r)
  );
}

// ─── 3) Clear all types for one origin ──────────────────────────────────────
function clearAllTypesForOrigin(origin, typesMask) {
  const originMask={}, globalMask={}, ops=[];
  Object.keys(typesMask).forEach(t=>{
    if (!typesMask[t]) return;
    if (ORIGIN_FILTERABLE.includes(t)) originMask[t]=true;
    else globalMask[t]=true;
  });
  if (Object.keys(originMask).length)
    ops.push(new Promise(r=>chrome.browsingData.remove({since:0,origins:[origin]}, originMask, r)));
  if (Object.keys(globalMask).length)
    ops.push(new Promise(r=>chrome.browsingData.remove({since:0}, globalMask, r)));
  return Promise.all(ops);
}

// ─── 4) Main clearing logic ──────────────────────────────────────────────────
function clearBrowsingData(forFiltered) {
  return getSettings().then(settings => {
    const types = settings.types;
    const fullMask = types.reduce((m,t)=>(m[t]=true,m),{});

    // A) Manual “Clear Filtered”
    if (forFiltered && settings.filters.length) {
      return Promise.all(
        settings.filters.map(o => clearAllTypesForOrigin(o, fullMask))
      ).then(()=>finalizeClear(
        settings,
        `Cleared data for filtered origins: ${settings.filters.join(', ')}`
      ));
    }

    // B) Auto-clear skipping preserved
    if (!forFiltered && settings.filters.length) {
      return new Promise(res=>{
        chrome.cookies.getAll({}, cookies=>{
          const allOrigs = Array.from(new Set(cookies.map(cookieToOrigin)));
          const toClear = allOrigs.filter(o=>!settings.filters.includes(o));

          const originTypes = types.filter(t=>ORIGIN_FILTERABLE.includes(t));
          const globalTypes = types.filter(t=>!ORIGIN_FILTERABLE.includes(t));
          const originMask = originTypes.reduce((m,t)=>(m[t]=true,m),{});
          const globalMask = globalTypes.reduce((m,t)=>(m[t]=true,m),{});
          const jobs = [];
          if (Object.keys(originMask).length)
            jobs.push(new Promise(r=>chrome.browsingData.remove({since:0,origins:toClear},originMask,r)));
          if (Object.keys(globalMask).length)
            jobs.push(new Promise(r=>chrome.browsingData.remove({since:0},globalMask,r)));
          Promise.all(jobs).then(res);
        });
      }).then(()=>finalizeClear(settings,'Auto-clear: skipped filtered sites'));
    }

    // C) No filters → global clear
    return new Promise(r=>chrome.browsingData.remove({since:0},fullMask,r))
      .then(()=>finalizeClear(settings,'Cleared data types for all sites'));
  });
}

// ─── 5) Logging & events ────────────────────────────────────────────────────
function addLog(details) {
  const ts = new Date().toISOString();
  return new Promise(res=>{
    chrome.storage.local.get(['logs'],r=>{
      const logs = r.logs||[];
      logs.push({ timestamp: ts, details });
      chrome.storage.local.set({ logs }, ()=>res({ timestamp: ts, details }));
    });
  });
}
function clearLogs() {
  return new Promise(res=>chrome.storage.local.set({ logs: [] }, res));
}

chrome.runtime.onInstalled.addListener(()=>getSettings().then(scheduleAlarm));
chrome.runtime.onStartup.addListener(()=>getSettings().then(scheduleAlarm));
chrome.alarms.onAlarm.addListener(a=>{
  if (a.name!=='autoClear') return;
  clearBrowsingData(false).then(({details,settings})=>{
    addLog(details).then(()=>{
      if (settings.notifications && !inQuietHours(settings)) {
        chrome.notifications.create('',{
          type:'basic',
          iconUrl:chrome.runtime.getURL('icons/tray-128.png'),
          title:'Auto Clear',
          message:details
        });
      }
    });
  });
});
chrome.runtime.onMessage.addListener((msg,_s,respond)=>{
  switch(msg.action){
    case 'getSettings': getSettings().then(s=>respond({settings:s})); return true;
    case 'saveSettings': saveSettings(msg.settings).then(()=>respond({success:true})); return true;
    case 'clearNow':
      clearBrowsingData(false).then(({details,settings})=>
        addLog(details).then(log=>respond({log,settings}))
      );
      return true;
    case 'clearFiltered':
      clearBrowsingData(true).then(({details,settings})=>
        addLog(details).then(log=>respond({log,settings}))
      );
      return true;
    case 'clearSite':
      getSettings().then(settings=>{
        const mask = settings.types.reduce((m,t)=>(m[t]=true,m),{});
        clearAllTypesForOrigin(msg.origin,mask).then(()=>{
          const details = `Cleared data for ${msg.origin}`;
          addLog(details).then(log=>respond({log,settings}));
        });
      });
      return true;
    case 'getLogs':
      chrome.storage.local.get(['logs'],r=>respond({logs:r.logs||[]}));
      return true;
    case 'clearLogs':
      clearLogs().then(()=>respond({success:true}));
      return true;
  }
});
