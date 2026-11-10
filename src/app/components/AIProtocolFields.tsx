import type { AIProviderConfig } from "../types";
import { protocolFor } from "../services/aiProvider";
import { Select } from "./Select";

type Props = {
  config: AIProviderConfig;
  idPrefix: string;
  onChange: <Key extends keyof AIProviderConfig>(key: Key, value: AIProviderConfig[Key]) => void;
};

/** 设置页与首次引导共用，避免两处的协议与路径语义不同。 */
export function AIProtocolFields({ config, idPrefix, onChange }: Props) {
  const responses = protocolFor(config) === "responses";
  const requestPathKey = responses ? "responsesPath" : "chatCompletionsPath";
  return (
    <>
      <div className="extension-field">
        <label htmlFor={`${idPrefix}-protocol`}>API 协议</label>
        <Select
          id={`${idPrefix}-protocol`}
          value={protocolFor(config)}
          onChange={(value) => onChange("apiProtocol", value as AIProviderConfig["apiProtocol"])}
          options={[
            { value: "chat_completions", label: "Chat Completions" },
            { value: "responses", label: "Responses" },
          ]}
        />
      </div>
      <div className="extension-field">
        <label htmlFor={`${idPrefix}-request-path`}>生成请求路径（可选）</label>
        <input
          id={`${idPrefix}-request-path`}
          className="extension-control"
          value={config[requestPathKey] ?? ""}
          onChange={(event) => onChange(requestPathKey, event.target.value)}
          placeholder={responses ? "/responses" : "/chat/completions"}
        />
      </div>
      <div className="extension-field">
        <label htmlFor={`${idPrefix}-models-path`}>模型列表路径（可选）</label>
        <input
          id={`${idPrefix}-models-path`}
          className="extension-control"
          value={config.modelsPath ?? ""}
          onChange={(event) => onChange("modelsPath", event.target.value)}
          placeholder="/models"
        />
      </div>
    </>
  );
}
