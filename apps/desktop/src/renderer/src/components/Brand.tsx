type BrandMarkProps = {
  size?: number;
  className?: string;
};

export function BrandMark({ size = 18, className = "" }: BrandMarkProps) {
  return <svg
    className={`brand-mark ${className}`.trim()}
    width={size}
    height={size}
    viewBox="0 0 64 64"
    fill="none"
    aria-hidden="true"
  >
    <path d="M6.3 4C5.6 4.7 5.1 6.3 5.5 7.3L42.8 37.3C45.5 38.4 48.2 38 50.3 37.3C56.3 34.8 60 29.5 60 23.8V18.1C60 10.3 53.7 4 45.7 4H6.3Z" fill="currentColor" />
    <path d="M17.4 27.3C15.8 27.3 14.3 28 13.2 29L8.6 33.5C5.6 36.4 4 40.3 4 44.6V48.5C4 54.9 9.4 60 16 60H59.2C59.7 59.2 59.7 58.2 59.2 57.3L23.4 28C21.5 27.3 19.4 27.1 17.4 27.3Z" fill="currentColor" opacity=".68" />
  </svg>;
}

export function Wordmark() {
  return <div className="wordmark"><BrandMark size={20} /><span>Reify</span><small>器成</small></div>;
}
