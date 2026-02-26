import { useEffect, useMemo, useRef, useState } from 'react';
import { ChangeEvent, HostedFieldsState } from './ConfidoLegal';

export interface Params {
  formType: 'card' | 'ach';
  paymentToken?: string;
  savePaymentMethodToken?: string;
  surchargingOptions?: {
    principalAmount?: number;
    surchargeRegion?: string;
  };
}

type UseConfidoLegalReturn = {
  state: HostedFieldsState | undefined;
  hf: typeof window.gravityLegal;
};

export const useConfidoLegal = (params: Params): UseConfidoLegalReturn => {
  const initParams = useMemo(
    () => ({
      paymentToken: params.paymentToken,
      savePaymentMethodToken: params.savePaymentMethodToken,
      surchargingOptions: {
        principalAmount: params.surchargingOptions?.principalAmount,
        surchargeRegion: params.surchargingOptions?.surchargeRegion,
      },
    }),
    [
      params.paymentToken,
      params.savePaymentMethodToken,
      params.surchargingOptions?.principalAmount,
      params.surchargingOptions?.surchargeRegion,
    ]
  );

  const [hostedFieldsState, setHostedFieldsState] =
    useState<HostedFieldsState>();

  useEffect(() => {
    const hf = window.gravityLegal;

    const listener = (e: ChangeEvent) => {
      const { state } = e;
      console.log('change', e);
      setHostedFieldsState(state);
    };

    hf.addChangeListener(listener);

    const fieldStyle = {
      border: 'none',
      color: 'rgb(26, 32, 44)',
      'font-family':
        '-apple-system, "system-ui", "Segoe UI", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol"',
      'font-weight': 400,
      height: '38px',
      width: '100%',
      'font-size': '16px',
    };

    hf.init({
      paymentToken: initParams.paymentToken,
      savePaymentMethodToken: initParams.savePaymentMethodToken,
      activeForm: params.formType,
      fields: {
        accountNumber: {
          containerId: 'account-number',
          style: fieldStyle,
        },
        accountHolderName: {
          containerId: 'account-holder-name',
          style: fieldStyle,
        },
        routingNumber: {
          containerId: 'routing-number',
          style: fieldStyle,
        },
        cardNumber: {
          containerId: 'card-number',
          style: fieldStyle,
        },
        cardExpirationDate: {
          containerId: 'card-exp',
          style: fieldStyle,
        },
        cardSecurityCode: {
          containerId: 'card-cvv',
          style: fieldStyle,
        },
      },
      surchargingOptions: initParams.surchargingOptions,
    });

    return () => hf.removeChangeListener(listener);
  }, [initParams]);

  const isInitialMount = useRef(true);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    window.gravityLegal.setActiveForm(params.formType);
  }, [params.formType]);

  return {
    hf: window.gravityLegal,
    state: hostedFieldsState,
  };
};
