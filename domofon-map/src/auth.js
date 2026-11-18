import { supabase } from './supabase.js';

const $overlay = document.getElementById('auth-overlay');
const $form = document.getElementById('auth-form');
const $title = document.getElementById('auth-title');
const $email = document.getElementById('auth-email');
const $name = document.getElementById('auth-name');
const $nameLabel = document.getElementById('auth-name-label');
const $password = document.getElementById('auth-password');
const $submit = document.getElementById('auth-submit');
const $toggle = document.getElementById('auth-toggle');
const $error = document.getElementById('auth-error');

let mode = 'login';

const ERROR_RU = {
  'Invalid login credentials': 'Неверный email или пароль.',
  'User already registered': 'Этот email уже зарегистрирован — переключитесь на вход.',
  'Email not confirmed': 'Email не подтверждён. Откройте письмо от Supabase или отключите «Confirm email» в настройках проекта.',
  'Password should be at least 6 characters': 'Пароль должен быть не короче 6 символов.',
  'Unable to validate email address: invalid format': 'Похоже, в email опечатка.',
  'Signup requires a valid password': 'Введите пароль (не короче 6 символов).',
};

function showError(msg) {
  $error.textContent = msg;
  $error.classList.remove('hidden');
}

function setMode(next) {
  mode = next;
  $error.classList.add('hidden');
  $title.textContent = mode === 'login' ? 'Вход' : 'Регистрация';
  $submit.textContent = mode === 'login' ? 'Войти' : 'Создать аккаунт';
  $toggle.textContent = mode === 'login'
    ? 'Нет аккаунта? Зарегистрироваться'
    : 'Уже есть аккаунт? Войти';
  $password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $nameLabel.classList.toggle('hidden', mode !== 'register');
}

export function showAuth() {
  $overlay.classList.remove('hidden');
  $email.focus();
}

export function hideAuth() {
  $overlay.classList.add('hidden');
  $form.reset();
  $error.classList.add('hidden');
}

export function initAuth() {
  $toggle.addEventListener('click', () => setMode(mode === 'login' ? 'register' : 'login'));

  $form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $error.classList.add('hidden');
    $submit.disabled = true;
    $submit.textContent = 'Подождите…';

    const email = $email.value.trim();
    const password = $password.value;
    try {
      if (mode === 'register') {
        const displayName = $name.value.trim();
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { data: { display_name: displayName || email.split('@')[0] } },
        });
        if (error) throw error;
        if (!data.session) {
          setMode('login');
          showError('Аккаунт создан. Подтвердите email по письму, затем войдите.');
          return;
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
      // Успешный вход обработает onAuthStateChange в main.js.
    } catch (e) {
      showError(ERROR_RU[e.message] || e.message);
    } finally {
      $submit.disabled = false;
      $submit.textContent = mode === 'login' ? 'Войти' : 'Создать аккаунт';
    }
  });
}