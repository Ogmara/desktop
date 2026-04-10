/**
 * Tray badge — renders the app icon with an unread count overlay
 * and updates the system tray icon via Rust backend.
 *
 * Linux/Windows tray icons have no native badge API, so we draw
 * the count directly onto the icon image using canvas.
 */

import { invoke } from '@tauri-apps/api/core';

const ICON_SIZE = 32;
let baseIconData: ImageData | null = null;
let lastCount = -1;

/** Base app icon embedded as data URL (32x32 PNG from src-tauri/icons). */
const ICON_BASE64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABmJLR0QA/wD/AP+gvaeTAAAEkUlEQVRYhcXW228UVRzA8e/vzHRndrfbvYEs9gItbRVSBPHWFHwiURPrBR7lxTfjJSL8BUR90UQj8CQx4UWeDL75oPEOpGBEilKuS0tbSmnpttu9Xzp7fGi7UGG3RQ09yc6eOTm/8zkzc34zRyiXVitQl3tDhNc0dABeEIQ7i9xRk/tsJw2cEy1H/Ak5FCWaL/cIhxvqnRn9DcgmKgz1H/EF5yC92lTdsdjlEYFWK+DPnnqA+PxZr3+aTiNQ53kbkdcfMA5IJG+pMYWwaxnwuT+9SwEblgWfrXcooHaZcARqzX+D++wIbU0v4qltoEiJ6cwIE7FeJm+dZWGpigNg3g9uGm4cJ8f2Jz5g1apO0FBQmqShKSpIZIa5eGY/Y8M/LgkHwXDb/n2L4UoMXtr0Pi8/+Qmp4hQTyau4rCAj8bPE0oM4UsJ0hzDtACtbnsdVG2Hy+nFAV8UBzKVc+Ssb99HRuJOCaEzDw9noYfoGvrqjh+Dzr6N9y3sEm7YRad+BI5ro8Q+r4gCG2w7sq4Z3RJ5j+6N7mFFwIvoFpy4fQikD07BwGS5sl5ca0yKdvsnotW8xTDe+yGY8D60nPRUlGx+oiAOoarggvPDIXjRwZewXjl04gOXy4DItSk6BfDFLOjdNJpfAY/sRNNHT+5m8fgKNUP/UW4CqiAsyO4FKq705uIWAt5GSwE8XPkVEoUSRL2Qoab0gJptL4LbrABj4/QBaNHaohdrVj1XEAVS1PG8KPo4WGEtdZSLZj1XjJptPlvu1r+yifeXWclQun8K2faQnr5CJD6IFvKs3V8ShvAjvxgGCngZKwK1kFIBSySn3q1/VxdbOzwDInNzDyFgPWuu5WCE73Y+5Yi013khFHKR6FpS0piSgZbZVSXnJkDNhyKfL9fkyPwU9/1OLvFuqpWA8dwMNhHzrAMEwaqCYBYTJkR5+O7YXEFIjPXeNYAeb0SIUEiMV8bkJVJ7d4OQZSkDI10y4ro1Y4goe2082lwAgNdizIMZt15HLJfCE2rCCzcwIZG7+WfV7UjULhqfOMJ4aIOZWdG14F1AUihkslxcR43aEKGzLRz6fBBSNnbtxOZCNXyM7eq4iDlWzYPYZHrt0kEBO0xh5lvVrd+A4MxSKOUzTwrZ92LYfy+Uln0+itbCmczd1TV3kaoSxEwfnRrk3DhWz4Pbx0uj3NAwepa15J6bpxet5GDFqSCWHKBZvD+UNtrPm6XfwrdmGIzDRd5TEwM9VcRAk7G/WS/me+7z1ZPNTvNr9HdrlJpbsJ5EeoiQaK9iCHWpmRsGMIYxd/JrhXz9Ca4dq+NwdWNpmIpm+gVIG08lr1IbXU+tvwR1aV0YdIBMfYOiPz5nq/2HRKy/Xwv4WvRi+sF0RXrGRwIpN2HX1OKLJpEeJj/eSGu9jsWf+z3YJ+1v0fW6j7tH+b7Zu5SwgtVw4kFCgzi8TjsB5JVp/uRw4AFqOSCutVtzPSYHNDxRH9YamnWdUlGhem6ob6H2QuGFKdx99BQMgm40lM/nVh71WaRwhBBIQcP3PeErDaaXl41Ci9ObV7F9xgL8BqJKVBzRyTgsAAAAASUVORK5CYII=';

/** Load the base app icon into an ImageData for reuse. */
async function getBaseIcon(): Promise<ImageData> {
  if (baseIconData) return baseIconData;
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = ICON_SIZE;
      canvas.height = ICON_SIZE;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, ICON_SIZE, ICON_SIZE);
      baseIconData = ctx.getImageData(0, 0, ICON_SIZE, ICON_SIZE);
      resolve(baseIconData);
    };
    img.onerror = reject;
    img.src = ICON_BASE64;
  });
}

/** Render the icon with a badge count overlay. */
function renderBadgeIcon(base: ImageData, count: number): Uint8Array {
  const canvas = document.createElement('canvas');
  canvas.width = ICON_SIZE;
  canvas.height = ICON_SIZE;
  const ctx = canvas.getContext('2d')!;

  // Draw base icon
  ctx.putImageData(base, 0, 0);

  if (count > 0) {
    const text = count > 99 ? '99' : String(count);
    const badgeRadius = count > 9 ? 10 : 9;
    const cx = ICON_SIZE - badgeRadius;
    const cy = ICON_SIZE - badgeRadius;

    // Dark background circle (no border)
    ctx.fillStyle = '#2d2d3d';
    ctx.beginPath();
    ctx.arc(cx, cy, badgeRadius, 0, Math.PI * 2);
    ctx.fill();

    // White text
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${count > 9 ? 11 : 13}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, cx, cy + 1);
  }

  return new Uint8Array(ctx.getImageData(0, 0, ICON_SIZE, ICON_SIZE).data);
}

/** Update the tray icon with the current unread count. */
export async function updateTrayBadge(count: number): Promise<void> {
  // Skip if count hasn't changed
  if (count === lastCount) return;
  lastCount = count;

  try {
    const base = await getBaseIcon();
    const rgba = renderBadgeIcon(base, count);
    await invoke('update_tray_badge', {
      rgba: Array.from(rgba),
      width: ICON_SIZE,
      height: ICON_SIZE,
      count,
    });
  } catch {
    // Tray badge update is non-critical
  }
}
