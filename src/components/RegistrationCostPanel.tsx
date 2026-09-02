import { Show, createResource } from 'solid-js';
import { t } from '../i18n/init';
import { loadRegistrationCost, formatKlv, type RegistrationCost } from '../lib/registration';

/**
 * Shows what verifying a wallet will cost, BEFORE the user commits.
 *
 * Deliberately never blocks: if the fee cannot be read, it says so and leaves
 * the button enabled, because the wallet's own confirmation still shows the
 * real amount. Refusing to let someone verify because a lookup failed would be
 * a worse failure than an unlabelled amount.
 */
export function RegistrationCostPanel(props: { onLoaded?: (c: RegistrationCost) => void }) {
  const [cost] = createResource(async () => {
    const c = await loadRegistrationCost();
    props.onLoaded?.(c);
    return c;
  });

  return (
    <div class="reg-cost">
      <Show when={cost.loading}>
        <p class="wallet-desc muted">{t('verification_fee_loading')}</p>
      </Show>
      <Show when={cost() && !cost()!.known}>
        <p class="wallet-desc muted">{t('verification_fee_unknown')}</p>
      </Show>
      <Show when={cost()?.known}>
        <ul class="reg-cost-list">
          <li>
            <span>{t('verification_fee_label')}</span>
            <strong>
              {cost()!.feeAtomic === 0
                ? t('verification_fee_free')
                : `${cost()!.feeKlv} KLV`}
            </strong>
          </li>
          <Show when={cost()!.feeAtomic > 0 && cost()!.operatorAddress && cost()!.shareBps > 0}>
            <li class="muted">
              <span>{t('verification_fee_node_share')}</span>
              <span>
                {formatKlv(Math.floor((cost()!.feeAtomic * cost()!.shareBps) / 10_000))} KLV
                {' '}({cost()!.shareBps / 100}%)
              </span>
            </li>
          </Show>
          <li class="muted">
            <span>{t('verification_fee_network')}</span>
            <span>~4.4 KLV</span>
          </li>
        </ul>
        <p class="wallet-desc muted">{t('verification_fee_unlocks')}</p>
      </Show>
    </div>
  );
}
