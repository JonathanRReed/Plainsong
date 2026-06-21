import * as React from "react";
import { cn } from "@/lib/utils";

const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { variant?: "default" | "glass" | "interactive" | "elevated" | "borderless" }
>(({ className, variant = "default", ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "rounded-md bg-card text-card-foreground transition-smooth",
      variant === "default" &&
        "border border-border/60 shadow-[0_1px_0_hsl(var(--foreground)/0.03)_inset] hover:border-border",
      variant === "glass" &&
        "glass border border-border/60 shadow-[0_1px_0_hsl(var(--foreground)/0.03)_inset] hover:shadow-[0_14px_38px_hsl(34_26%_4%/0.1)]",
      variant === "interactive" &&
        "border border-border/60 cursor-pointer shadow-[0_1px_0_hsl(var(--foreground)/0.03)_inset] hover:-translate-y-0.5 hover:border-border hover:shadow-[0_14px_38px_hsl(34_26%_4%/0.12)] active:translate-y-0",
      variant === "elevated" && "border-0 shadow-[0_20px_60px_hsl(34_26%_4%/0.16)] hover:shadow-[0_24px_70px_hsl(34_26%_4%/0.2)]",
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
      "font-serif text-2xl font-semibold leading-none tracking-tight",
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
