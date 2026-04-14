'use strict';

const bar         = document.getElementById('bar');
const statusEl    = document.getElementById('status');
const btnDownload = document.getElementById('btn-download');
const btnRetry    = document.getElementById('btn-retry');

const phaseLabel = {
  checking:   'Đang kiểm tra manifest...',
  downloading:'Đang tải...',
  verifying:  'Đang xác minh tính toàn vẹn...',
  extracting: 'Đang giải nén...',
  hoisting:   'Đang cấu hình extension deps...',
  swapping:   'Đang áp dụng...',
  complete:   'Hoàn tất! Đang khởi động...',
  error:      'Cài đặt thất bại.',
};

function startDownload() {
  btnDownload.disabled = true;
  btnRetry.style.display = 'none';
  bar.className = 'bar';
  statusEl.className = 'status';
  statusEl.textContent = 'Đang bắt đầu...';
  window.setupAPI.startDownload();
}

function resetUI() {
  btnDownload.disabled = false;
  btnRetry.style.display = 'none';
  bar.style.width = '0%';
  bar.className = 'bar';
  statusEl.textContent = 'Sẵn sàng tải backend.';
  statusEl.className = 'status';
}

btnDownload.addEventListener('click', startDownload);
btnRetry.addEventListener('click', resetUI);

window.setupAPI.onProgress((state) => {
  const pct = typeof state.progressPercent === 'number'
    ? state.progressPercent
    : state.phase === 'complete' ? 100 : 0;

  bar.style.width = pct + '%';
  statusEl.textContent = state.message || phaseLabel[state.phase] || state.phase;

  if (state.phase === 'error') {
    bar.className = 'bar error';
    statusEl.className = 'status error';
    btnDownload.disabled = false;
    btnRetry.style.display = 'block';
  } else if (state.phase === 'complete') {
    bar.style.width = '100%';
    statusEl.className = 'status ok';
  }
});
