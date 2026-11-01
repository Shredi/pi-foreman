import { Key, matchesKey, TuiAltScreen, truncateToWidth, type Component, type Terminal } from "@earendil-works/pi-tui";
import type { PreviewFixture, ScreenId } from "../plan-types.ts";
import { SCREEN_IDS, SCREENS } from "./screens/index.ts";
import { bold, dim, fit, inverse } from "./style.ts";
import { CaptureTerminal } from "./term.ts";

const KEYS_BAR = "1-7 screens, Tab/arrow navigate, q quit";

/** Full-screen setup shell: header, one screen, keys bar, confirm overlay. */
export class SetupApp implements Component {
  readonly tui: TuiAltScreen;
  private screenId: ScreenId = "home";
  private screen: Component;
  private finish!: () => void;
  /** Resolves when the user quits. */
  readonly done = new Promise<void>((resolve) => (this.finish = resolve));

  private fixture: PreviewFixture;
  private terminal: Terminal;

  constructor(fixture: PreviewFixture, terminal: Terminal) {
    this.fixture = fixture;
    this.terminal = terminal;
    this.tui = new TuiAltScreen(terminal);
    this.screen = this.build("home");
  }

  private build(id: ScreenId): Component {
    return SCREENS[id](this.fixture, { rows: () => Math.max(1, this.terminal.rows - 2), ui: this.terminal instanceof CaptureTerminal ? undefined : this.tui });
  }

  get current(): ScreenId {
    return this.screenId;
  }

  showScreen(id: ScreenId): void {
    this.disposeScreen();
    this.screenId = id;
    this.screen = this.build(id);
    this.tui.requestRender();
  }

  /** Ask a yes/no question in a centred overlay; y or Enter confirms, n or Escape declines. */
  confirm(message: string): Promise<boolean> {
    return new Promise((resolve) => {
      let handle: { hide(): void } | undefined;
      const answer = (yes: boolean) => {
        handle?.hide();
        this.tui.setFocus(this);
        resolve(yes);
      };
      const box: Component = {
        render: (width) => {
          const inner = Math.max(1, width - 4);
          const row = (t: string) => `│ ${fit(t, inner)} │`;
          return [`┌${"─".repeat(width - 2)}┐`, row(message), row(""), row(dim("y/Enter yes, n/Esc no")), `└${"─".repeat(width - 2)}┘`];
        },
        invalidate: () => {},
        handleInput: (data) => {
          if (data === "y" || matchesKey(data, Key.enter)) answer(true);
          else if (data === "n" || matchesKey(data, Key.escape)) answer(false);
        },
      };
      handle = this.tui.showOverlay(box, { width: 52, anchor: "center" });
    });
  }

  invalidate(): void {}

  render(width: number): string[] {
    const rows = this.terminal.rows;
    const title = this.fixture.screens.find((s) => s.id === this.screenId)?.title ?? this.screenId;
    const pos = `${SCREEN_IDS.indexOf(this.screenId) + 1}/${SCREEN_IDS.length}`;
    const header = inverse(fit(` pi-foreman setup  ${bold(title)}`.padEnd(Math.max(0, width - pos.length - 1)) + pos + " ", width));
    const area = this.screen.render(width).map((l) => truncateToWidth(l, width, "…"));
    while (area.length < rows - 2) area.push("");
    return [header, ...area.slice(0, Math.max(0, rows - 2)), dim(fit(KEYS_BAR, width))];
  }

  handleInput(data: string): void {
    if (data === "q" || matchesKey(data, "ctrl+c")) return this.quit();
    const n = Number(data);
    if (Number.isInteger(n) && n >= 1 && n <= SCREEN_IDS.length) return this.showScreen(SCREEN_IDS[n - 1]);
    const step = matchesKey(data, Key.tab) ? 1 : matchesKey(data, "shift+tab") ? -1 : 0;
    if (step) return this.showScreen(SCREEN_IDS[(SCREEN_IDS.indexOf(this.screenId) + step + SCREEN_IDS.length) % SCREEN_IDS.length]);
    this.screen.handleInput?.(data);
    this.tui.requestRender();
  }

  start(): void {
    this.tui.addChild(this);
    this.tui.setFocus(this);
    this.tui.start();
  }

  /** Stop timers a screen owns (the apply screen's spinner). */
  private disposeScreen(): void {
    (this.screen as { dispose?: () => void }).dispose?.();
  }

  quit(): void {
    this.disposeScreen();
    this.tui.stop();
    this.finish();
  }
}
