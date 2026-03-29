/* @refresh reload */
import { render } from 'solid-js/web';
import { App } from './App';
import { initI18n } from './i18n';
import { initTheme } from './theme';
import './styles.css';

initI18n();
initTheme();

const root = document.getElementById('root');
if (root) {
  render(() => <App />, root);
}
