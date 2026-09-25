import { render } from 'preact';
import '../lib/brand.css';
import { App } from './App';
import './popup.css';
import { uiLang } from '../lib/i18n';

document.documentElement.lang = uiLang() === 'zh' ? 'zh-CN' : 'en';

render(<App />, document.getElementById('app')!);
