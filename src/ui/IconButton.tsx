import { clsx } from "clsx";
import type { LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";
import styles from "./Button.module.css";

interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: LucideIcon;
  /** Accessible label (also used as the tooltip). */
  label: string;
  size?: number;
}

export function IconButton({
  icon: Icon,
  label,
  size = 15,
  className,
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      className={clsx(styles.btn, styles.iconBtn, className)}
      aria-label={label}
      title={label}
      {...rest}
    >
      <Icon size={size} strokeWidth={1.75} aria-hidden />
    </button>
  );
}
