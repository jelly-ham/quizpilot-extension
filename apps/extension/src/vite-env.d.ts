/// <reference types="vite/client" />
/// <reference types="@crxjs/vite-plugin/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE: string;
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}
