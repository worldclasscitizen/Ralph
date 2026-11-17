import type { RefObject } from "react";
import { Icon } from "./presentation";
import { type Language, useText } from "./locale";

export type Theme = "light" | "dark";

function Segment({
  label,
  left,
  right,
  first,
  onClick,
  disabled = false,
}: {
  label: string;
  left: string;
  right: string;
  first: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="setting-segment"
      aria-label={label}
      aria-pressed={first}
      disabled={disabled}
      onClick={onClick}
    >
      <span data-active={first}>{left}</span>
      <span data-active={!first}>{right}</span>
    </button>
  );
}

export function Settings({
  dialog,
  language,
  setLanguage,
  theme,
  setTheme,
  notify,
  setNotify,
  easyKorean,
  setEasyKorean,
}: {
  dialog: RefObject<HTMLDialogElement | null>;
  language: Language;
  setLanguage: (language: Language) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  notify: boolean;
  setNotify: (enabled: boolean) => void;
  easyKorean: boolean;
  setEasyKorean: (enabled: boolean) => void;
}) {
  const t = useText();
  return (
    <dialog
      ref={dialog}
      className="settings-dialog"
      aria-labelledby="settings-title"
      onClick={(event) => {
        if (event.target === event.currentTarget) dialog.current?.close();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") event.stopPropagation();
      }}
    >
      <div className="settings-content">
        <div className="settings-heading">
          <h2 id="settings-title">{t("설정", "Settings")}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label={t("설정 닫기", "Close settings")}
            onClick={() => dialog.current?.close()}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="settings-row">
          <strong>Language</strong>
          <Segment
            label="Language"
            left="한국어"
            right="English"
            first={language === "ko"}
            onClick={() => setLanguage(language === "ko" ? "en" : "ko")}
          />
        </div>
        <div className="settings-row">
          <strong>{t("화면 테마", "Theme")}</strong>
          <Segment
            label={t("화면 테마", "Theme")}
            left={t("라이트", "Light")}
            right={t("다크", "Dark")}
            first={theme === "light"}
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          />
        </div>
        <div className="settings-row" data-disabled={language === "en"}>
          <div>
            <strong>{t("쉬운 한국어", "Plain Korean")}</strong>
            <p>
              {t(
                "Codex의 경량 모델을 활용해 작업 내용을 이해하기 쉬운 말로 번역합니다.",
                "Uses a lightweight Codex model to translate work details into plain Korean.",
              )}
            </p>
          </div>
          <Segment
            label={t("쉬운 한국어 설명", "Plain Korean")}
            left="ON"
            right="OFF"
            first={language === "ko" && easyKorean}
            disabled={language === "en"}
            onClick={() => setEasyKorean(!easyKorean)}
          />
        </div>
        <div className="settings-row">
          <div>
            <strong>
              {t(
                "확인이 필요한 보고 알림",
                "Alerts for reports that need attention",
              )}
            </strong>
            <p>
              {t(
                "실행이 멈추거나 내 확인이 필요할 때 알려줘요.",
                "Get notified when work stops or needs your attention.",
              )}
            </p>
          </div>
          <Segment
            label={t("확인이 필요한 보고 알림", "Report alerts")}
            left="ON"
            right="OFF"
            first={notify}
            onClick={() => setNotify(!notify)}
          />
        </div>
      </div>
    </dialog>
  );
}
