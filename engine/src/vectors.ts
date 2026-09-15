/** East/north vectors in knots; bearings are degrees true. Keep rounding at the caller. */
export interface VelocityKt {
  u_kt: number;
  v_kt: number;
}

const DEG = Math.PI / 180;

/** Component along the course: positive is fair, negative is foul. No rounding for ETA/routing. */
export function alongCourseComponentKt(sample: VelocityKt, courseDegTrue: number): number {
  return sample.u_kt * Math.sin(courseDegTrue * DEG) + sample.v_kt * Math.cos(courseDegTrue * DEG);
}

/** Meteorological FROM direction (0° northerly), opposite the vector's travel direction. */
export function windFromDeg(uKt: number, vKt: number): number {
  return (Math.atan2(-uKt, -vKt) / DEG + 360) % 360;
}
