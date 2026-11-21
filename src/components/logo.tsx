import clsx from "clsx";

/** Logo Vatel Cantine (fichier de la marque, version légère 96 px) + le mot-symbole */
export function Logo({ className, mark = false }: { className?: string; mark?: boolean }) {
  return (
    <span className={clsx("inline-flex items-center gap-2", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/vatel-mark-96.png" alt="" width={36} height={36} className="size-9 rounded-full bg-white" />
      {!mark && <span className="text-[22px] font-extrabold tracking-tight">vatel</span>}
    </span>
  );
}
