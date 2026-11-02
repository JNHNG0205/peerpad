export function Splash({ message = 'Opening workspace…' }: { message?: string }) {
  return (
    <div className="grid min-h-dvh place-items-center">
      <div className="flex flex-col items-center gap-4 text-muted">
        <div className="relative size-10">
          <span className="absolute inset-0 animate-ping rounded-full bg-accent/30" />
          <span className="absolute inset-2 rounded-full bg-accent" />
        </div>
        <p className="text-sm">{message}</p>
      </div>
    </div>
  )
}
