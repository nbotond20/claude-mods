import { Icon, Tooltip } from '@loam/ui-web';
import { fmt } from './api';

/** Real hours against the target, like a price change: green up when over, red down when under. */
export function Delta({ real, target, size = 'sm' }: { real: number; target: number | null; size?: 'sm' | 'xs' }) {
  if (!target) return null;
  const diff = real - target;
  const even = Math.abs(diff) < 0.005;
  const tone = even ? 'text-ink-3' : diff > 0 ? 'text-good' : 'text-danger';
  return (
    <Tooltip content={`Real ${fmt(real)} h against a ${fmt(target)} h target`}>
      <span className={`inline-flex items-center gap-0.5 font-medium tabular-nums ${size === 'xs' ? 'text-11' : 'text-12'} ${tone}`}>
        {even ? '=' : <Icon name={diff > 0 ? 'arrow-up' : 'arrow-down'} size={size === 'xs' ? 11 : 12} />}
        {even ? '' : `${diff > 0 ? '+' : '−'}${fmt(Math.abs(diff))}`}
      </span>
    </Tooltip>
  );
}
