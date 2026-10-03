import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

function Input({
  className,
  type,
  ...props
}) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base text-foreground transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-zinc-500 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/60 disabled:text-muted-foreground disabled:opacity-100 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/25 md:text-sm dark:bg-input/30 dark:placeholder:text-zinc-400 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/45",
        className
      )}
      {...props} />
  );
}

export { Input }
