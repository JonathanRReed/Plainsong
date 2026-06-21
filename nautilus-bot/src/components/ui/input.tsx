import * as React from "react";
import { cn } from "@/lib/utils";

interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  error?: boolean;
  success?: boolean;
  helperText?: string;
  inputSize?: "default" | "sm" | "lg";
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, leftIcon, rightIcon, error, success, helperText, inputSize = "default", ...props }, ref) => {
    return (
      <div className="w-full">
        <div className="relative">
          {leftIcon && (
            <div className={cn(
              "absolute top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none",
              inputSize === "default" && "left-3",
              inputSize === "sm" && "left-2.5",
              inputSize === "lg" && "left-4"
            )}>
              {leftIcon}
            </div>
          )}
          <input
            type={type}
            className={cn(
              "flex w-full rounded-md border bg-background ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 transition-all duration-200",
              inputSize === "default" && "h-10 px-3 py-2 text-sm",
              inputSize === "sm" && "h-8 px-2.5 py-1.5 text-xs",
              inputSize === "lg" && "h-12 px-4 py-3 text-base",
              leftIcon && (inputSize === "default" ? "pl-10" : inputSize === "sm" ? "pl-8" : "pl-12"),
              rightIcon && (inputSize === "default" ? "pr-10" : inputSize === "sm" ? "pr-8" : "pr-12"),
              error && "border-rust focus-visible:ring-rust",
              success && "border-gold focus-visible:ring-gold",
              !error && !success && "focus-visible:border-primary/50",
              className
            )}
            ref={ref}
            {...props}
          />
          {rightIcon && (
            <div className={cn(
              "absolute top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none",
              inputSize === "default" && "right-3",
              inputSize === "sm" && "right-2.5",
              inputSize === "lg" && "right-4"
            )}>
              {rightIcon}
            </div>
          )}
        </div>
        {helperText && (
          <p
            className={cn(
              "mt-1",
              inputSize === "default" && "text-xs",
              inputSize === "sm" && "text-[10px]",
              inputSize === "lg" && "text-sm",
              error && "text-rust",
              success && "text-gold-text",
              !error && !success && "text-muted-foreground"
            )}
          >
            {helperText}
          </p>
        )}
      </div>
    );
  }
);
Input.displayName = "Input";

export { Input };
