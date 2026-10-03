import { render } from 'preact';
import '../lib/brand.css';
import { App } from './App';
import './popup.css';
import { htmlLang } from '../lib/i18n';

document.documentElement.lang = htmlLang();

render(<App />, document.getElementById('app')!);
