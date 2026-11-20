import * as SwitchPrimitive from "@radix-ui/react-switch";

type SwitchProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
};

/** 统一封装 Radix Switch，保证键盘操作、aria-checked 状态与动画在不同页面保持一致。 */
export function Switch({
  checked,
  onCheckedChange,
  disabled = false,
  id,
  className = "",
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
  "aria-describedby": ariaDescribedby,
}: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledby}
      aria-describedby={ariaDescribedby}
      className={`ui-switch ${className}`.trim()}
    >
      <SwitchPrimitive.Thumb className="ui-switch__thumb" />
    </SwitchPrimitive.Root>
  );
}
