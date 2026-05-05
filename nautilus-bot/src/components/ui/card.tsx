import * as React from "react";
import { cn } from "@/lib/utils";

const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { variant?: "default" | "glass" | "interactive" | "elevated" | "borderless" }
>(({ className, variant = "default", ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "rounded-lg bg-card text-card-foreground transition-all duration-200",
      variant === "default" &&
        "border border-border/70 shadow-[0_1px_0_hsl(var(--foreground)/0.04)_inset] hover:border-primary/25 hover:shadow-[0_18px_45px_hsl(225_22%_3%/0.12)]",
      variant === "glass" &&
        "glass border border-border/70 shadow-[0_1px_0_hsl(var(--foreground)/0.04)_inset] hover:shadow-[0_18px_45px_hsl(225_22%_3%/0.12)]",
      variant === "interactive" &&
        "border border-border/70 cursor-pointer shadow-[0_1px_0_hsl(var(--foreground)/0.04)_inset] hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-[0_18px_45px_hsl(225_22%_3%/0.14)] active:translate-y-0",
      variant === "elevated" && "border-0 shadow-[0_24px_70px_hsl(225_22%_3%/0.18)] hover:shadow-[0_28px_80px_hsl(225_22%_3%/0.22)]",
      variant === "borderless" && "border-0 shadow-none hover:shadow-sm",
      className
    )}
    {...props}
  />
));
Card.displayName = "Card";

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-col gap-1.5 p-6", className)}
    {...props}
  />
));
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h3
    ref={ref}
    className={cn(
      "text-2xl font-semibold leading-none tracking-tight",
      className
    )}
    {...props}
  />
));
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
));
CardContent.displayName = "CardContent";

export { Card, CardHeader, CardTitle, CardDescription, CardContent };
