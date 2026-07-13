import { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import SecretInput from './SecretInput';

describe('SecretInput', () => {
  beforeEach(() => {
    cleanup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a masked placeholder when a secret is saved but the field is empty', () => {
    render(
      <SecretInput
        id="s"
        label="Secret"
        value=""
        placeholder="enter secret"
        original={true}
        onChange={vi.fn()}
      />,
    );
    const input = screen.getByPlaceholderText('••••••••') as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.type).toBe('password');
    expect(input.value).toBe('');
  });

  it('toggles visibility when the eye is clicked and no reveal handler is provided', () => {
    render(
      <SecretInput
        id="s"
        label="Secret"
        value="abc"
        placeholder="enter secret"
        original={undefined}
        onChange={vi.fn()}
      />,
    );
    const input = screen.getByDisplayValue('abc') as HTMLInputElement;
    expect(input.type).toBe('password');
    fireEvent.click(screen.getByRole('button'));
    expect(input.type).toBe('text');
    fireEvent.click(screen.getByRole('button'));
    expect(input.type).toBe('password');
  });

  it('calls onReveal and shows the returned plaintext when the eye is clicked for a saved secret', async () => {
    const onReveal = vi.fn().mockResolvedValue('plain-secret');
    render(
      <SecretInput
        id="s"
        label="Secret"
        value=""
        placeholder="enter secret"
        original={true}
        onChange={vi.fn()}
        onReveal={onReveal}
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    expect(onReveal).toHaveBeenCalledTimes(1);

    const input = await screen.findByDisplayValue('plain-secret') as HTMLInputElement;
    expect(input.type).toBe('text');
  });

  it('does not call onReveal when a value has already been entered', () => {
    const onReveal = vi.fn().mockResolvedValue('plain-secret');
    render(
      <SecretInput
        id="s"
        label="Secret"
        value="typed-value"
        placeholder="enter secret"
        original={true}
        onChange={vi.fn()}
        onReveal={onReveal}
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    expect(onReveal).not.toHaveBeenCalled();
  });

  it('displays an already-revealed original string without calling onReveal', () => {
    render(
      <SecretInput
        id="s"
        label="Secret"
        value=""
        placeholder="enter secret"
        original="known-secret"
        onChange={vi.fn()}
      />,
    );
    const input = screen.getByDisplayValue('known-secret') as HTMLInputElement;
    expect(input).toBeInTheDocument();
  });

  it('keeps the field empty after the user clears a revealed secret', () => {
    function Wrapper() {
      const [value, setValue] = useState('');
      return (
        <SecretInput
          id="s"
          label="Secret"
          value={value}
          placeholder="enter secret"
          original="known-secret"
          onChange={setValue}
        />
      );
    }
    render(<Wrapper />);

    const input = screen.getByDisplayValue('known-secret') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });

    expect(input.value).toBe('');
  });

  it('shows the revealed plaintext even after the user cleared the field', async () => {
    const onReveal = vi.fn().mockResolvedValue('plain-secret');
    function Wrapper() {
      const [value, setValue] = useState('');
      return (
        <SecretInput
          id="s"
          label="Secret"
          value={value}
          placeholder="enter secret"
          original={true}
          onChange={setValue}
          onReveal={onReveal}
        />
      );
    }
    render(<Wrapper />);

    const input = screen.getByPlaceholderText('••••••••') as HTMLInputElement;
    // Type something and clear it — the field is now in "edited" state.
    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.change(screen.getByDisplayValue('x'), { target: { value: '' } });

    fireEvent.click(screen.getByRole('button'));

    expect(await screen.findByDisplayValue('plain-secret')).toBeInTheDocument();
  });
});
