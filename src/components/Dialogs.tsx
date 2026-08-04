/**
 * Dialogs — custom confirm/prompt modal, replacing `window.confirm`/`window.prompt`.
 *
 * Tauri's dialog plugin (2.7.0) injects a script that overrides `window.confirm`
 * to call an IPC command named `confirm` — but the plugin only ever registers
 * `open`/`save`/`message` on the Rust side (see `tauri-plugin-dialog::lib.rs`
 * `generate_handler![...]`). `window.confirm` is therefore UNCONDITIONALLY
 * broken (`dialog.confirm not allowed. Command not found`) no matter what
 * capabilities are granted — this isn't a missing permission, the command
 * doesn't exist. `window.prompt` isn't touched by that override at all, so it
 * falls through to the raw webview engine, and WebKitGTK (Linux) has long had
 * gaps in `window.prompt` support (silently returns `null`, no dialog shown).
 * Both were found live blocking kick/ban/delete/leave/report actions on
 * desktop Linux (2026-08) with NO visible error for the prompt case.
 *
 * Fix: never call `window.confirm`/`window.prompt` in this app — use
 * {@link confirmDialog}/{@link promptDialog} instead, which render this
 * self-hosted, themed modal (mounted once at the app root, see App.tsx).
 */
import { Component, Show, createSignal } from 'solid-js';
import { t } from '../i18n/init';

type Request =
  | { kind: 'confirm'; message: string; resolve: (v: boolean) => void }
  | { kind: 'prompt'; message: string; defaultValue: string; password: boolean; resolve: (v: string | null) => void };

const [active, setActive] = createSignal<Request | null>(null);
const [inputValue, setInputValue] = createSignal('');

/** Replacement for `window.confirm(message)`. Resolves `true`/`false`. */
export function confirmDialog(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    setActive({ kind: 'confirm', message, resolve });
  });
}

/** Replacement for `window.prompt(message, defaultValue)`. Resolves the
 *  entered string, or `null` if cancelled — same contract as `window.prompt`.
 *  Pass `{ password: true }` for sensitive input (e.g. a PIN) so it's masked. */
export function promptDialog(
  message: string,
  options?: string | { defaultValue?: string; password?: boolean },
): Promise<string | null> {
  const opts = typeof options === 'string' ? { defaultValue: options } : (options ?? {});
  const defaultValue = opts.defaultValue ?? '';
  return new Promise((resolve) => {
    setInputValue(defaultValue);
    setActive({ kind: 'prompt', message, defaultValue, password: !!opts.password, resolve });
  });
}

function isMaskedPrompt(r: Request): boolean {
  return r.kind === 'prompt' && r.password;
}

function settle(value: boolean | string | null): void {
  const req = active();
  if (!req) return;
  setActive(null);
  // Don't let a sensitive value (e.g. a PIN) linger in the shared input
  // signal after its dialog closes — it's already overwritten by the next
  // promptDialog() call before render, but clear it eagerly regardless.
  setInputValue('');
  if (req.kind === 'confirm') req.resolve(value === true);
  else req.resolve(typeof value === 'string' ? value : null);
}

/** Global confirm/prompt modal host. Mount exactly once at the app root. */
export const DialogHost: Component = () => {
  let inputRef: HTMLInputElement | undefined;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') settle(active()?.kind === 'confirm' ? false : null);
    if (e.key === 'Enter') settle(active()?.kind === 'confirm' ? true : inputValue());
  };

  return (
    <>
    <Show when={active()}>
      {(req) => (
      <div
        class="dlg-overlay"
        onClick={(e) => { if (e.target === e.currentTarget) settle(req().kind === 'confirm' ? false : null); }}
        onKeyDown={onKeyDown}
      >
        <div class="dlg-card" role="dialog" aria-modal="true">
          <p class="dlg-message">{req().message}</p>
          <Show when={req().kind === 'prompt'}>
            <input
              ref={(el) => {
                inputRef = el;
                queueMicrotask(() => { el?.focus(); el?.select(); });
              }}
              class="dlg-input"
              type={isMaskedPrompt(req()) ? 'password' : 'text'}
              value={inputValue()}
              onInput={(e) => setInputValue(e.currentTarget.value)}
              onKeyDown={onKeyDown}
              autocomplete="off"
            />
          </Show>
          <div class="dlg-actions">
            <button
              class="dlg-btn dlg-cancel"
              onClick={() => settle(req().kind === 'confirm' ? false : null)}
            >
              {t('cancel')}
            </button>
            <button
              class="dlg-btn dlg-ok"
              ref={(el) => { if (req().kind === 'confirm') queueMicrotask(() => el?.focus()); }}
              onClick={() => settle(req().kind === 'confirm' ? true : inputValue())}
            >
              {t('dialog_ok')}
            </button>
          </div>
        </div>
      </div>
      )}
    </Show>
    <style>{`
        .dlg-overlay {
          position: fixed; inset: 0;
          background: rgba(0, 0, 0, 0.6);
          display: flex; align-items: center; justify-content: center;
          z-index: 1200;
        }
        .dlg-card {
          background: var(--color-bg-secondary);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-lg);
          padding: var(--spacing-lg);
          width: 380px; max-width: 90vw;
          display: flex; flex-direction: column;
          gap: var(--spacing-md);
        }
        .dlg-message {
          margin: 0;
          color: var(--color-text-primary);
          font-size: var(--font-size-sm);
          white-space: pre-wrap;
        }
        .dlg-input {
          width: 100%;
          padding: var(--spacing-sm) var(--spacing-md);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          background: var(--color-bg-tertiary);
          color: var(--color-text-primary);
          font-size: var(--font-size-sm);
        }
        .dlg-input:focus {
          outline: none;
          border-color: var(--color-accent-primary);
        }
        .dlg-actions {
          display: flex; gap: var(--spacing-sm);
          justify-content: flex-end;
        }
        .dlg-btn {
          padding: var(--spacing-sm) var(--spacing-md);
          border-radius: var(--radius-md);
          font-weight: 600;
          font-size: var(--font-size-sm);
          cursor: pointer;
          transition: opacity 0.15s;
        }
        .dlg-cancel {
          background: var(--color-bg-tertiary);
          color: var(--color-text-primary);
        }
        .dlg-ok {
          background: var(--color-accent-primary);
          color: var(--color-text-inverse);
        }
        .dlg-btn:hover { opacity: 0.85; }
      `}</style>
    </>
  );
};
