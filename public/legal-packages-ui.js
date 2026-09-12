const stateLabels = { staged: 'Загружен', approved: 'Согласован', active: 'Активен', expired: 'Истёк' };

// Administrative controls stay deliberately small: all requests happen only
// from an explicit action, while the server remains the source of truth.
export class LegalPackagesUI {
  constructor({ api, esc, btn, render, getBoot }) {
    Object.assign(this, { api, esc, btn, render, getBoot });
    this.packages = null;
    this.error = '';
  }

  canManage() { return Boolean(this.getBoot()?.legalPackages?.canManage); }

  package(packageId) { return (this.packages || []).find(item => item.packageId === packageId); }

  fileInput() {
    return globalThis.document?.querySelector('[data-legal-package-file]');
  }

  reasonInput(packageId) {
    return globalThis.document?.querySelector(`[data-legal-package-reason="${this.esc(packageId)}"]`);
  }

  async request(work) {
    this.error = '';
    try { await work(); }
    catch (error) { this.error = error?.message || 'Не удалось выполнить действие.'; }
    this.render();
  }

  view() {
    if (!this.canManage()) return '';
    const { esc, btn } = this;
    const packages = this.packages || [];
    return `<section class="flow legal-packages" aria-labelledby="legal-packages-title">
      <div class="row between"><h2 id="legal-packages-title">Нормативные пакеты</h2>${btn('Обновить список', 'legal-package-load', '', 'quiet compact-action')}</div>
      <p class="muted">Импортируйте подписанный JSON-пакет, затем согласуйте и активируйте его отдельными действиями. Справочные редакции требуют проверки ответственным.</p>
      <div class="row"><input type="file" data-legal-package-file accept="application/json,.json">${btn('Импортировать JSON', 'legal-package-import', '', 'compact-action')}</div>
      ${this.error ? `<p class="error" role="alert" tabindex="-1">${esc(this.error)}</p>` : ''}
      ${this.packages === null ? '<p class="muted">Список не загружен. Нажмите «Обновить список».</p>' : packages.length ? packages.map(item => this.packageView(item)).join('') : '<p class="muted">Пакетов пока нет.</p>'}
    </section>`;
  }

  packageView(item) {
    const { esc, btn } = this;
    const state = stateLabels[item.state] || item.state || 'Неизвестно';
    const controls = item.state === 'staged'
      ? `<label>Основание согласования<textarea data-legal-package-reason="${esc(item.packageId)}" maxlength="4000" rows="2" required></textarea></label>${btn('Согласовать', 'legal-package-approve', item.packageId, 'compact-action')}`
      : item.state === 'approved'
        ? btn('Активировать', 'legal-package-activate', item.packageId, 'compact-action')
        : '';
    return `<article class="version legal-package"><div class="row between"><h3>${esc(item.packageId)}</h3><span class="badge">${esc(state)}</span></div>
      <p>${esc(item.version)} · ${esc(item.edition)} · ${esc(item.legalStatus)}</p>
      <small>Digest: <code>${esc(item.digest)}</code> · ключ: ${esc(item.signatureKeyId)} · действует до ${esc(item.expiresAt)}</small>
      ${item.modules?.length ? `<small>Модулей: ${item.modules.length}</small>` : ''}
      ${controls ? `<div class="flow">${controls}</div>` : ''}
    </article>`;
  }

  async action(action, value = '') {
    if (!this.canManage()) return;
    if (action === 'legal-package-load') return this.request(async () => {
      const data = await this.api('/legal-packages');
      this.packages = Array.isArray(data?.packages) ? data.packages : [];
    });
    if (action === 'legal-package-import') return this.request(async () => {
      const file = this.fileInput()?.files?.[0];
      if (!file) throw new Error('Выберите JSON-файл нормативного пакета.');
      let packageData;
      try { packageData = JSON.parse(await file.text()); }
      catch { throw new Error('Файл не является корректным JSON.'); }
      await this.api('/legal-packages', packageData);
      this.packages = null;
    });
    const item = this.package(value);
    if (!item) return this.request(async () => { throw new Error('Пакет не найден. Обновите список.'); });
    if (action === 'legal-package-approve') return this.request(async () => {
      const reason = String(this.reasonInput(value)?.value || '').trim();
      if (!reason) throw new Error('Укажите основание согласования.');
      await this.api(`/legal-packages/${encodeURIComponent(item.packageId)}/approve`, { digest: item.digest, decision: 'approved', reason });
      this.packages = null;
    });
    if (action === 'legal-package-activate') return this.request(async () => {
      await this.api(`/legal-packages/${encodeURIComponent(item.packageId)}/activate`, { digest: item.digest });
      this.packages = null;
    });
  }
}
