import { render } from 'preact';
import '../lib/brand.css';
import { Options } from './Options';
import './options.css';
import { t, uiLang } from '../lib/i18n';

document.documentElement.lang = uiLang() === 'zh' ? 'zh-CN' : 'en';
document.title = t('opt_title');

render(<Options />, document.getElementById('app')!);
