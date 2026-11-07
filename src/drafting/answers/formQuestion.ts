export type FormQuestion = {
  key: string;
  label: string;
  required: boolean;
  /** input_text | textarea | multi_value_single_select | input_file | ... */
  type: string;
  options?: string[];
  /**
   * The option the employer itself marked as declining to answer, where the ATS
   * publishes that flag. Only set on voluntary self-identification questions.
   */
  declineOption?: string;
};
