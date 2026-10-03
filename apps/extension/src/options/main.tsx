import { render } from 'preact';
import '../lib/brand.css';
import { Options } from './Options';
import './options.css';
import { t, htmlLang } from '../lib/i18n';

document.documentElement.lang = htmlLang();
document.title = t('opt_title');

render(<Options />, document.getElementById('app')!);
