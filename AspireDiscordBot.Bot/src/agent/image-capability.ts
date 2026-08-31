export class ImageCapabilityError extends Error {
  public constructor(public readonly userMessage: string) {
    super(userMessage);
    this.name = 'ImageCapabilityError';
  }
}
