import logoLight from '../assets/toprope.svg';
import logoDark from '../assets/toprope-inverted.svg';

/**
 * Toprope wordmark lockup. Two source SVGs (black text for light, white text for
 * dark — both keep the orange mark) are swapped by the `dark` class on <html>
 * via Tailwind visibility, so the switch is instant and needs no JS. The alt
 * text carries the product name for the one that renders; the hidden twin is
 * decorative (alt="") so screen readers don't announce it twice.
 */
export function Logo({className = 'h-7'}: {className?: string}): JSX.Element {
    return (
        <span className="inline-flex items-center">
            <img src={logoLight} alt="Toprope" className={`${className} w-auto block dark:hidden`} />
            <img src={logoDark} alt="" aria-hidden="true" className={`${className} w-auto hidden dark:block`} />
        </span>
    );
}
