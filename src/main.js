// ── OpenClaw JARVIS UI — 主入口 ──

// Global API Patch (must be imported first)
import './patch-api.js';

// 設定載入（最先）
import { loadConfig } from './config/config-loader.js';
import { initTheme } from './config/theme.js';

// 核心
import { initScene, animateScene, onWindowResize, zoomCameraForAudio, setDistortion, setResolution, resetAnomaly, getOrbScreenPosition } from './core/scene.js';
import { initAudio, initAudioControls, getAnalyser, getAudioData, getFrequencyData, getAudioLevel, calculateAudioMetrics, updateAudioWave, setZoomCallback } from './core/audio.js';
import { initFloatingParticles } from './core/particles.js';

// 元件
import { initChat, updateUserActivity } from './components/chat.js';
import { showNotification } from './components/notifications.js';
import { initSystemMonitor } from './components/system-monitor.js';
import { initTabs } from './components/tabs.js';
import { initTasks } from './components/tasks.js';
import { initSkills } from './components/skills.js';
import { initMemory } from './components/memory.js';
import { initSchedule } from './components/schedule.js';
import { initControls, setCallbacks, getAudioReactivity, getAudioSensitivity } from './components/controls.js';
import { initSpectrumCollapse, drawSpectrumAnalyzer, drawCircularVisualizer, drawWaveform, initVisualizers, resizeAllCanvases } from './components/spectrum.js';
import { setupPreloader } from './components/preloader.js';
import { initDraggablePanels } from './components/draggable.js';
import { initTimestamp } from './components/timestamp.js';
import { initOrbMessages } from './components/orb-messages.js';
import { initThoughtStream } from './components/thought-stream.js';
import { initMobileToolbar } from './components/mobile-toolbar.js';
import { initPowerSave, isPowerSave } from './components/powersave.js';
import { initVoiceUI } from './components/voice-ui.js';
import { initGeminiLive } from './components/gemini-live.js';
import { initOpenAiLive } from './components/openai-live.js';
import { initUsage } from './components/usage.js';
import { initVoicePicker } from './components/voice-picker.js';
import { initLiveVoicePicker } from './components/live-voice-picker.js';
import { initCartesiaVoicePicker } from './components/cartesia-voice-picker.js';
import { initSttPicker } from './components/stt-picker.js';
import { initModelPicker } from './components/model-picker.js';
import { initBrainPicker } from './components/brain-picker.js';
import { initSessions } from './components/sessions.js';
import { initControlPanel } from './components/control-panel.js';
import { initMobileMenu } from './components/mobile-menu.js';
import { initDebugLog } from './utils/debug-log.js';

document.addEventListener('DOMContentLoaded', async function () {
  initDebugLog();
  // 載入設定
  const config = await loadConfig();
  
  // 初始化主題系統（最早執行，確保 CSS 變數正確）
  initTheme();

  // 動態更新 HTML 中的個人化文字
  document.title = config.name || 'JARVIS';
  const agentName = config.agent?.name || 'JARVIS';
  const chatLabel = document.querySelector('.terminal-panel.chat-panel .terminal-header span');
  if (chatLabel) chatLabel.textContent = agentName;

  // 設定 agent prefix CSS 變數
  const emoji = config.agent?.emoji || 'AI';
  document.documentElement.style.setProperty('--agent-prefix', `"${agentName} ${emoji} "`);

  // 載入畫面
  setupPreloader();

  // 元件初始化
  initChat();
  initTabs();
  initTasks();
  initSkills();
  initMemory();
  initSchedule();
  initControls();
  initVoiceUI();
  initGeminiLive();
  initOpenAiLive();
  initUsage();
  initVoicePicker();
  initLiveVoicePicker();
  initCartesiaVoicePicker();
  initSttPicker();
  initBrainPicker();
  initModelPicker();
  initSessions();
  initControlPanel();
  initPowerSave();
  initMobileMenu();
  initSpectrumCollapse();
  initSystemMonitor();
  initVisualizers();
  initTimestamp();
  initAudioControls();
  initMobileActionDock();

  // 控制滑桿回呼（連結場景）
  setCallbacks({
    onDistortion: setDistortion,
    onResolution: setResolution,
  });

  // 音訊 → 場景 zoom 回呼
  setZoomCallback(zoomCameraForAudio);

  // Orb 狀態文字（agent-state → #orb-status）
  const orbStatus = document.getElementById('orb-status');
  if (orbStatus) {
    const labels = {
      idle: 'Ready',
      thinking: 'Thinking',
      responding: 'Speaking',
    };
    window.addEventListener('agent-state', (e) => {
      orbStatus.textContent = labels[e.detail] || e.detail.toUpperCase();
      orbStatus.className = 'scanner-id state-' + (e.detail || 'idle');
      if (window.matchMedia('(max-width: 768px)').matches) {
        orbStatus.classList.add('mobile-orb-status');
      }

      // 狀態視覺回饋：掃描線速度 + 粒子活躍度
      const scannerLine = document.querySelector('.scanner-line');
      const scannerFrame = document.querySelector('.scanner-frame');
      if (scannerLine) {
        switch (e.detail) {
          case 'thinking':
            scannerLine.style.animationDuration = '1.5s';
            scannerFrame?.classList.add('state-active');
            break;
          case 'responding':
            scannerLine.style.animationDuration = '2.5s';
            scannerFrame?.classList.add('state-active');
            break;
          default:
            scannerLine.style.animationDuration = '4s';
            scannerFrame?.classList.remove('state-active');
        }
      }
    });
  }

  // Orb 右側 meta（channel + 訊息數）
  const orbMeta = document.getElementById('orb-meta');
  if (orbMeta) {
    let msgCount = 0;
    let channelName = '';

    const updateMeta = () => {
      orbMeta.textContent = channelName
        ? `${channelName}${msgCount ? ` - ${msgCount} MSGS` : ''}`
        : (msgCount ? `${msgCount} MSGS` : '');
    };

    // 初始化：從 server 拿 channel + 今日計數
    fetch('/api/status').then(r => r.json()).then(d => {
      channelName = (d.channel || '').toUpperCase();
      msgCount = d.msgCount || 0;
      updateMeta();
    }).catch(() => {});

    // 每次發訊息後更新計數
    window.addEventListener('agent-state', (e) => {
      if (e.detail === 'thinking') { msgCount++; updateMeta(); }
    });
  }

  // 使用者活動追蹤
  document.addEventListener('mousemove', updateUserActivity);
  document.addEventListener('keydown', updateUserActivity);

  // 載入完成後啟動
  const loadingOverlay = document.getElementById('loading-overlay');
  setTimeout(() => {
    loadingOverlay.style.opacity = 0;
    setTimeout(() => {
      loadingOverlay.style.display = 'none';
      initAudio();
      initFloatingParticles();
      initDraggablePanels();
      initOrbMessages(getOrbScreenPosition);
      initThoughtStream();
      initMobileToolbar();
    }, 500);
  }, 3000);

  // Three.js 場景
  initScene();
  
  // 暴露 resetAnomaly 供 Controls 使用
  window.__jarvisResetAnomaly = resetAnomaly;
  
  // 重新觸發主題，確保 Three.js 顏色同步
  initTheme();

  // 視窗大小變更
  window.addEventListener('resize', () => {
    onWindowResize(resizeAllCanvases);
  });

  // 主動畫循環
  let lastFrameTime = 0;
  function animate(now) {
    requestAnimationFrame(animate);

    // 頁面隱藏時完全暫停
    if (window.__jarvisHiddenPause?.()) return;

    // 省電模式：限制 15fps
    if (isPowerSave()) {
      if (now - lastFrameTime < 66) return; // ~15fps
      lastFrameTime = now;
    }

    const analyser = getAnalyser();
    const frequencyData = getFrequencyData();
    const audioData = getAudioData();
    const audioSensitivity = getAudioSensitivity();
    const audioReactivity = getAudioReactivity();

    // 音訊視覺化（僅在有分析器且非省電時）
    let audioLevel = 0;
    if (analyser && !isPowerSave()) {
      // 先填充數據（一幀只讀一次）
      analyser.getByteFrequencyData(frequencyData);
      analyser.getByteTimeDomainData(audioData);
      audioLevel = getAudioLevel(audioSensitivity);  // 使用已填充的 frequencyData
      drawCircularVisualizer(frequencyData, audioSensitivity, audioReactivity);
      drawSpectrumAnalyzer(frequencyData, audioSensitivity);
      updateAudioWave(audioReactivity, audioSensitivity);
      calculateAudioMetrics(audioSensitivity);
    }

    // 波形圖（省電時不畫）
    if (!isPowerSave()) {
      drawWaveform(analyser ? audioData : null);
    }

    // 3D 場景
    const rotationSpeed = parseFloat(document.getElementById('rotation-slider')?.value || 1);
    animateScene(audioLevel, rotationSpeed, audioReactivity);
  }
  animate(0);

  // 1. 頁面切背景自動暫停渲染
  let hiddenPause = false;
  document.addEventListener('visibilitychange', () => {
    hiddenPause = document.hidden;
  });
  // 暴露給 animate loop
  window.__jarvisHiddenPause = () => hiddenPause;
});

function initMobileActionDock() {
  if (window.__mobileActionDockBound) return;
  window.__mobileActionDockBound = true;
  relocateMobileOrbStatus();

  const setChatOpen = (open) => {
    const btn = document.getElementById('mobile-chat-toggle');
    document.body.classList.toggle('mobile-chat-open', open);
    btn?.classList.toggle('active', open);
    btn?.setAttribute('aria-label', open ? 'Close chat' : 'Open chat');
  };

  setChatOpen(false);

  document.addEventListener('click', (e) => {
    const chatBtn = e.target.closest?.('#mobile-chat-toggle');
    if (chatBtn) {
      e.preventDefault();
      setChatOpen(!document.body.classList.contains('mobile-chat-open'));
      return;
    }

    const moreBtn = e.target.closest?.('#mobile-more-toggle');
    if (moreBtn) {
      e.preventDefault();
      openMobileMoreSheet();
    }
  });
}

function relocateMobileOrbStatus() {
  const status = document.getElementById('orb-status');
  if (!status || !window.matchMedia('(max-width: 768px)').matches) return;
  document.body.appendChild(status);
  status.classList.add('mobile-orb-status');
}

function openMobileMoreSheet() {
  let overlay = document.getElementById('mobile-more-overlay');
  let sheet = document.getElementById('mobile-more-sheet');

  if (!overlay || !sheet) {
    overlay = document.createElement('div');
    overlay.id = 'mobile-more-overlay';

    sheet = document.createElement('div');
    sheet.id = 'mobile-more-sheet';
    sheet.innerHTML = `
      <div class="mobile-more-handle"></div>
      <div class="mobile-more-head">
        <div>
          <strong>More</strong>
          <span>Useful controls</span>
        </div>
        <button type="button" class="mobile-more-close" aria-label="Close">x</button>
      </div>
      <div class="mobile-more-list">
        <button type="button" data-more-action="preferences"><span>P</span><b>Preferences</b></button>
        <button type="button" data-more-action="activity"><span>A</span><b>Activity</b></button>
        <button type="button" data-more-action="usage"><span>U</span><b>Usage</b></button>
        <button type="button" data-more-action="power"><span>L</span><b>Low power</b></button>
        <button type="button" data-more-action="stop" class="danger"><span>S</span><b>Stop assistant</b></button>
      </div>`;

    document.body.appendChild(overlay);
    document.body.appendChild(sheet);

    overlay.addEventListener('click', closeMobileMoreSheet);
    sheet.querySelector('.mobile-more-close')?.addEventListener('click', closeMobileMoreSheet);
    setupSwipeToClose(sheet, closeMobileMoreSheet);
    sheet.addEventListener('click', (e) => {
      const action = e.target.closest?.('[data-more-action]')?.dataset.moreAction;
      if (!action) return;
      handleMobileMoreAction(action);
    });
  }

  overlay.classList.add('open');
  sheet.classList.add('open');
  document.body.classList.add('mobile-more-open');
}

function closeMobileMoreSheet() {
  document.getElementById('mobile-more-overlay')?.classList.remove('open');
  document.getElementById('mobile-more-sheet')?.classList.remove('open');
  document.body.classList.remove('mobile-more-open');
}

function handleMobileMoreAction(action) {
  const clickEl = (selector) => document.querySelector(selector)?.click();
  closeMobileMoreSheet();

  if (action === 'preferences') {
    openMobileInfoSheet('controls');
  } else if (action === 'activity') {
    openMobileInfoSheet('tasks');
  } else if (action === 'usage') {
    clickEl('#usage-btn');
  } else if (action === 'power') {
    clickEl('#powersave-btn');
  } else if (action === 'stop') {
    clickEl('#jcp-stop');
  }
}

function openMobileInfoSheet(tab = 'tasks') {
  const panel = document.querySelector('.info-center');
  const overlay = document.getElementById('mobile-overlay');
  const chat = document.querySelector('.terminal-panel.chat-panel');
  if (!panel) return;

  panel.classList.add('mobile-slide');
  panel.offsetHeight;
  panel.classList.add('mobile-open');
  overlay?.classList.add('visible');
  chat?.classList.add('panel-behind');
  document.body.classList.add('mobile-sheet-open');

  document.querySelectorAll('.tab-btn-r').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.rtab === tab);
  });
  document.querySelectorAll('.rtab-content').forEach((content) => {
    content.classList.toggle('active', content.id === `rtab-${tab}`);
  });

  const close = () => {
    panel.classList.remove('mobile-open');
    overlay?.classList.remove('visible');
    chat?.classList.remove('panel-behind');
    document.body.classList.remove('mobile-sheet-open');
    setTimeout(() => {
      if (!panel.classList.contains('mobile-open')) panel.classList.remove('mobile-slide');
    }, 300);
    overlay?.removeEventListener('click', close);
  };
  overlay?.addEventListener('click', close);
  setupSwipeToClose(panel, close);
}

function setupSwipeToClose(sheet, close) {
  if (!sheet || sheet.dataset.swipeCloseBound === 'true') return;
  sheet.dataset.swipeCloseBound = 'true';

  let startY = 0;
  let dragging = false;

  sheet.addEventListener('touchstart', (e) => {
    const target = e.target;
    if (target.closest?.('input, textarea, select, button')) return;
    startY = e.touches[0].clientY;
    dragging = true;
    sheet.style.transition = 'none';
  }, { passive: true });

  sheet.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const delta = Math.max(0, e.touches[0].clientY - startY);
    sheet.style.transform = `translateY(${delta}px)`;
  }, { passive: true });

  sheet.addEventListener('touchend', (e) => {
    if (!dragging) return;
    dragging = false;
    const delta = Math.max(0, e.changedTouches[0].clientY - startY);
    sheet.style.transition = '';
    sheet.style.transform = '';
    if (delta > 80) close();
  }, { passive: true });
}

// Service Worker disabled — it caused stale cached bundles (unstyled loads, old JS).
// Unregister any existing SW and drop its caches so the app always loads fresh.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then((rs) => rs.forEach((r) => r.unregister()))
    .catch(() => {});
  if (window.caches && caches.keys) {
    caches.keys().then((keys) => keys.forEach((k) => caches.delete(k))).catch(() => {});
  }
}
