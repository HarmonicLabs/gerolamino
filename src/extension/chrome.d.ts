/**
 * The few `chrome.*` extension APIs Gerolamino uses, typed by hand (no @types/chrome dependency).
 * Shapes follow the Chrome MV3 reference; only what the code calls is declared.
 */
declare namespace chrome {
    namespace runtime {
        const id: string;
        const lastError: { message?: string } | undefined;
        function getURL(path: string): string;
        function getManifest(): { name: string; version: string };
        function sendMessage<T = any>(message: unknown): Promise<T>;
        function connect(info?: { name?: string }): Port;
        function getContexts(filter: { contextTypes?: string[]; documentUrls?: string[] }): Promise<Array<{ contextType: string; documentUrl?: string }>>;
        interface MessageSender { id?: string; url?: string; documentId?: string }
        interface Port {
            name: string;
            postMessage(message: unknown): void;
            disconnect(): void;
            onMessage: Event<(message: any, port: Port) => void>;
            onDisconnect: Event<(port: Port) => void>;
        }
        const onMessage: Event<(message: any, sender: MessageSender, sendResponse: (response?: any) => void) => boolean | void>;
        const onConnect: Event<(port: Port) => void>;
        const onInstalled: Event<(details: { reason: string }) => void>;
        const onStartup: Event<() => void>;
    }
    namespace tabs {
        function create(props: { url: string; active?: boolean }): Promise<unknown>;
    }
    namespace storage {
        interface StorageArea {
            get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
            set(items: Record<string, unknown>): Promise<void>;
            remove(keys: string | string[]): Promise<void>;
        }
        const local: StorageArea;
        const session: StorageArea;
        const onChanged: Event<(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string) => void>;
    }
    namespace offscreen {
        type Reason = "TESTING" | "AUDIO_PLAYBACK" | "IFRAME_SCRIPTING" | "DOM_SCRAPING" | "BLOBS" | "DOM_PARSER" | "USER_MEDIA" | "DISPLAY_MEDIA" | "WEB_RTC" | "CLIPBOARD" | "LOCAL_STORAGE" | "WORKERS" | "BATTERY_STATUS" | "MATCH_MEDIA" | "GEOLOCATION";
        function createDocument(params: { url: string; reasons: Reason[]; justification: string }): Promise<void>;
        function closeDocument(): Promise<void>;
    }
    namespace alarms {
        interface Alarm { name: string; scheduledTime: number; periodInMinutes?: number }
        function create(name: string, info: { delayInMinutes?: number; periodInMinutes?: number; when?: number }): Promise<void>;
        function get(name: string): Promise<Alarm | undefined>;
        const onAlarm: Event<(alarm: Alarm) => void>;
    }
    interface Event<T extends (...args: any[]) => any> {
        addListener(cb: T): void;
        removeListener(cb: T): void;
        hasListener(cb: T): boolean;
    }
}
