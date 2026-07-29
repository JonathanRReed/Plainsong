import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 font-mono text-[0.6875rem] font-medium tracking-[0.04em] whitespace-nowrap transition-smooth focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        destructive:
          "bg-rust/10 text-rust focus-visible:ring-rust/20 dark:bg-rust/20 dark:focus-visible:ring-rust/40 [a]:hover:bg-rust/20",
        outline:
          "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        // Retired semantic names, mapped centrally onto gold/rust/neutral so no
        // call site invents its own hue. Don't add new uses — reach for the
        // explicit variant, or a neume, instead.
        success:
          "bg-gold/12 text-gold-text border-gold/25 focus-visible:ring-gold/20 [a]:hover:bg-gold/20",
        warning:
          "bg-rust/12 text-rust border-rust/25 focus-visible:ring-rust/20 [a]:hover:bg-rust/20",
        info:
          "bg-muted/30 text-muted-foreground [a]:hover:bg-muted/40",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge }
